\## Skills



\### debug-report


Generate structured diagnostic reports for bugs and issues that the user can paste to another Claude instance (e.g., Claude.ai chat) for expert analysis. Use this skill whenever the user says something like "this isn't working", "I have a bug", "generate a report", "make a diagnostic", "help me debug this", "create a report for Claude", or any variation of needing to communicate a technical problem to another AI or person. Also trigger when the user is stuck on an issue after multiple failed attempts and needs a fresh perspective from another session. This skill should be used PROACTIVELY — if you've attempted 3+ fixes for the same issue without success, suggest generating a diagnostic report.


\# Debug Diagnostic Report Generator



\## Purpose



When the user hits a bug or issue, generate a \*\*structured diagnostic report\*\* formatted so that another Claude instance (in claude.ai chat, a different Claude Code session, or a human expert) can immediately understand the problem and find the root cause WITHOUT needing to re-explore the codebase.



The report must be \*\*self-contained\*\* — the reader should never need to ask "but what does the code actually look like?" or "what have you already tried?"



\## When to Generate a Report



\- The user explicitly asks for a diagnostic/report

\- You've attempted 3+ fixes for the same issue without resolving it

\- The issue spans multiple files/systems and is hard to summarize verbally

\- The user wants to paste the problem into another Claude session for a second opinion



\## Report Structure



Generate the report as a single markdown code block the user can copy-paste. Follow this exact structure:



```markdown

\## \[Short Problem Title] — \[Project Name] Diagnostic Report



\### What we're trying to do

\[1-3 sentences describing the intended behavior. Be specific — not "thumbnails should work" but "When a video source is imported, a JPEG thumbnail should render in an 80×45px img element in the SourceCard React component."]



\### What actually happens

\[1-3 sentences describing the observed behavior. Include exact error messages, visual symptoms, or incorrect values. If there's a screenshot or visual issue, describe what the user sees.]



\### Environment

\- OS: \[Windows 11 / macOS / Linux]

\- Runtime: \[Node 20.x / Electron 41 / etc.]

\- Key dependencies: \[JUCE 8.x, FFmpeg 7.x, React 18, etc.]

\- Hardware relevant to issue: \[GPU model if graphics issue, audio interface if audio issue]



\### Architecture Overview

\[Explain how the relevant systems connect. Use a simple flow diagram in text:



Component A → (IPC/bridge) → Component B → (renders) → Component C



Be specific about which process/thread each component runs in. This is critical for debugging issues that cross process boundaries.]



\### Code Involved

\[For EACH relevant file, show:]



\*\*`path/to/file.ext`\*\* — \[one-line description of this file's role]

```language

\[The SPECIFIC function/block that's relevant — not the entire file.

&#x20;Include 10-40 lines max per block. Add comments marking the problem area.]

```



\[Repeat for each file. Typically 2-5 files are involved.]



\### What the logs/output show

```

\[Paste the ACTUAL console output, error messages, or log lines.

&#x20;Annotate with ← arrows to highlight important lines.

&#x20;Include timestamps if relevant to timing issues.]

```



\### What we've already tried

\[Numbered list of every fix attempt, what it changed, and why it didn't work. Be specific:]

1\. \*\*\[Approach]\*\* — \[What was changed] → \[Result and why it failed]

2\. \*\*\[Approach]\*\* — \[What was changed] → \[Result and why it failed]

\[...]



\### Suspected root causes

\[Ranked list of remaining hypotheses, most likely first:]

1\. \*\*\[Hypothesis]\*\* — \[Why you suspect this, what evidence supports/contradicts it]

2\. \*\*\[Hypothesis]\*\* — \[Why you suspect this]

\[...]



\### Key files for the reader to examine

\[Bullet list of file paths the reader should look at, in priority order]



\### What to try next

\[Numbered list of specific, actionable steps the reader should attempt, in order. Each step should be a single change that can be tested independently.]

```



\## Report Quality Rules



\### DO:

\- Include ACTUAL code snippets, not descriptions of code ("the function does X" → show the function)

\- Include ACTUAL log output, not paraphrased logs

\- Show the data flow: where does the data originate, how does it transform, where does it arrive, where does it fail?

\- Mention what's WORKING correctly (helps narrow the problem space)

\- Include version numbers and exact error messages

\- Note which thread/process each component runs in (main, renderer, audio thread, video thread, worker)

\- If the issue is visual, describe exactly what the user sees (broken icon, black screen, wrong position, etc.)

\- Mark the boundary where things go from "working" to "broken" — e.g., "the data arrives correctly at the IPC handler (confirmed by log) but the renderer receives undefined"



\### DO NOT:

\- Include entire files — only the relevant 10-40 line blocks

\- Include code that's working fine and unrelated to the bug

\- Describe code instead of showing it

\- Omit failed attempts (the reader needs to know what's been ruled out)

\- Write vague hypotheses ("something might be wrong with the data") — be specific ("the base64 string may be truncated during IPC transfer because Electron's structured clone has a 256MB limit and the string is 55K chars")

\- Forget to mention the threading/process model — half of all hard bugs are threading bugs



\## Self-Check Before Delivering



Before giving the report to the user, verify:

\- \[ ] Can someone who has NEVER seen this codebase understand the problem?

\- \[ ] Are all code snippets actual code (not pseudocode or descriptions)?

\- \[ ] Is the log output actual output (not reconstructed from memory)?

\- \[ ] Is it clear WHERE in the pipeline the failure occurs?

\- \[ ] Are all failed attempts documented with their results?

\- \[ ] Would YOU be able to diagnose this from the report alone?



\## Proactive Trigger



If you've been working on the same bug for 3+ attempts without resolution, say:



"I've tried \[N] approaches and this one's proving stubborn. Want me to generate a diagnostic report you can paste into a fresh Claude chat for a second opinion? A fresh set of eyes on a structured summary often catches what I'm missing."

