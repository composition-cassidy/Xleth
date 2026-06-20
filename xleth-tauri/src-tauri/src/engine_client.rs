use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, oneshot, Mutex as AsyncMutex};

const PIPE_NAME: &str = r"\\.\pipe\XlethEngine";
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

#[derive(Deserialize)]
struct EngineResponse {
    id: u32,
    #[serde(default)]
    result: Value,
    error: Option<String>,
    #[serde(rename = "notImplemented", default)]
    not_implemented: bool,
}

pub struct EngineClient {
    writer: AsyncMutex<Option<WriteHalf<NamedPipeClient>>>,
    child: AsyncMutex<Option<Child>>,
    pending: Mutex<HashMap<u32, oneshot::Sender<EngineResponse>>>,
    next_id: AtomicU32,
    engine_path: PathBuf,
    shutting_down: AtomicBool,
    fatal_tx: broadcast::Sender<String>,
}

impl EngineClient {
    pub async fn start(engine_path: &Path) -> Result<Arc<Self>, String> {
        let _ = Command::new("taskkill")
            .args(["/f", "/im", "xleth-engine.exe"])
            .output()
            .await;
        let (fatal_tx, _) = broadcast::channel(8);
        let client = Arc::new(Self {
            writer: AsyncMutex::new(None),
            child: AsyncMutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            engine_path: engine_path.to_path_buf(),
            shutting_down: AtomicBool::new(false),
            fatal_tx,
        });
        client.spawn_and_connect().await?;
        let supervisor = client.clone();
        tokio::spawn(async move { supervisor.supervise().await });
        Ok(client)
    }

    pub fn subscribe_fatal(&self) -> broadcast::Receiver<String> {
        self.fatal_tx.subscribe()
    }

    async fn spawn_and_connect(self: &Arc<Self>) -> Result<(), String> {
        let exe_dir = self.engine_path.parent().unwrap_or(Path::new("."));
        let dll_dir = exe_dir.join("engine").join("Release");
        let working_dir = if dll_dir.is_dir() { &dll_dir } else { exe_dir };
        let child = Command::new(&self.engine_path)
            .current_dir(working_dir)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("spawn {} failed: {e}", self.engine_path.display()))?;
        eprintln!("xleth-engine.exe spawned, PID: {:?}", child.id());
        *self.child.lock().await = Some(child);

        let mut last_error = String::new();
        for attempt in 0..20 {
            match ClientOptions::new().open(PIPE_NAME) {
                Ok(pipe) => {
                    let (reader, writer) = tokio::io::split(pipe);
                    *self.writer.lock().await = Some(writer);
                    self.spawn_reader(reader);
                    eprintln!("Pipe connected after {attempt} retries");
                    return Ok(());
                }
                Err(e) => last_error = e.to_string(),
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        Err(format!("unable to connect to {PIPE_NAME}: {last_error}"))
    }

    fn spawn_reader(self: &Arc<Self>, mut reader: ReadHalf<NamedPipeClient>) {
        let client = self.clone();
        tokio::spawn(async move {
            loop {
                let mut header = [0u8; 4];
                if reader.read_exact(&mut header).await.is_err() {
                    break;
                }
                let length = u32::from_le_bytes(header) as usize;
                if length > MAX_FRAME_BYTES {
                    break;
                }
                let mut payload = vec![0u8; length];
                if reader.read_exact(&mut payload).await.is_err() {
                    break;
                }
                match serde_json::from_slice::<EngineResponse>(&payload) {
                    Ok(response) => {
                        if let Some(tx) = client.pending.lock().unwrap().remove(&response.id) {
                            let _ = tx.send(response);
                        }
                    }
                    Err(e) => eprintln!("engine response decode failed: {e}"),
                }
            }
        });
    }

    async fn supervise(self: Arc<Self>) {
        let mut failures = 0;
        loop {
            let mut child = match self.child.lock().await.take() {
                Some(child) => child,
                None => return,
            };
            let status = child.wait().await;
            if self.shutting_down.load(Ordering::Acquire) {
                return;
            }
            eprintln!("xleth-engine.exe exited: {status:?}");
            *self.writer.lock().await = None;
            let pending = std::mem::take(&mut *self.pending.lock().unwrap());
            drop(pending);

            failures += 1;
            if failures > 3 {
                let message = "xleth-engine.exe failed after 3 restart attempts".to_string();
                let _ = self.fatal_tx.send(message.clone());
                eprintln!("{message}");
                return;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
            match self.spawn_and_connect().await {
                Ok(()) => {
                    let reinitialized = match self.call("initialize", json!([])).await {
                        Ok(_) => self
                            .call(
                                "initVideoSharedMemory",
                                json!(["XlethFrameBuffer", 960, 540]),
                            )
                            .await
                            .map(|_| ()),
                        Err(e) => Err(e),
                    };
                    match reinitialized {
                        Ok(()) => eprintln!("xleth-engine.exe restarted ({failures}/3)"),
                        Err(e) => eprintln!("engine restart initialization failed: {e}"),
                    }
                }
                Err(e) => eprintln!("engine restart {failures}/3 failed: {e}"),
            }
        }
    }

    pub async fn call(&self, method: &str, args: Value) -> Result<Value, String> {
        if !args.is_array() {
            return Err("engine args must be a JSON array".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let payload = serde_json::to_vec(&json!({"id": id, "method": method, "args": args}))
            .map_err(|e| e.to_string())?;
        if payload.len() > MAX_FRAME_BYTES {
            return Err("engine command exceeds 64 MiB".into());
        }

        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let write_result = async {
            let mut guard = self.writer.lock().await;
            let writer = guard.as_mut().ok_or("engine pipe is not connected")?;
            writer
                .write_all(&(payload.len() as u32).to_le_bytes())
                .await
                .map_err(|e| e.to_string())?;
            writer
                .write_all(&payload)
                .await
                .map_err(|e| e.to_string())?;
            writer.flush().await.map_err(|e| e.to_string())
        }
        .await;
        if let Err(e) = write_result {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }

        let response = tokio::time::timeout(Duration::from_secs(30), rx)
            .await
            .map_err(|_| format!("engine command timed out after 30s: {method}"))?
            .map_err(|_| "engine response channel closed".to_string())?;
        if let Some(error) = response.error {
            Err(error)
        } else if response.not_implemented {
            Err(format!("not implemented: {method}"))
        } else {
            Ok(response.result)
        }
    }
}
