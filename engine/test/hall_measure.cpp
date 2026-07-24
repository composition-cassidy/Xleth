// hall_measure.cpp — Hall reverb re-tune measurement + A/B render tool.
//
// Not a pass/fail test. Prints Hall's character metrics (crest factor, stereo
// correlation, RT60-vs-knob curve, calibration wet RMS, onset echo-density)
// and renders two stereo WAV snippets (a transient-rich burst and a sustained
// chord) through Hall so the before/after character can be A/B-listened.
//
// Build:  cmake --build build --config Release --target hall_measure
// Run:    build\engine\Release\hall_measure.exe <output-prefix>
//         (writes <prefix>_transient.wav and <prefix>_chord.wav next to CWD)
//
// Used by docs/plans/reverb-audit-and-redesign.md Phase 3B (Hall re-tune):
// run once at HEAD for the baseline, once after the diffusion+stereo fix.

#include "audio/XlethReverbEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <random>
#include <string>
#include <vector>

// ─── Minimal 16-bit PCM stereo WAV writer (no juce_audio_formats dependency) ──
static void writeWav16(const std::string& path,
                       const std::vector<float>& L,
                       const std::vector<float>& R,
                       int sampleRate)
{
    const std::size_t n = std::min(L.size(), R.size());
    const int         numCh = 2;
    const int         bitsPerSample = 16;
    const int         byteRate = sampleRate * numCh * bitsPerSample / 8;
    const int         blockAlign = numCh * bitsPerSample / 8;
    const std::uint32_t dataBytes =
        static_cast<std::uint32_t>(n) * static_cast<std::uint32_t>(blockAlign);
    const std::uint32_t riffBytes = 36 + dataBytes;

    std::ofstream f(path, std::ios::binary);
    auto u32 = [&](std::uint32_t v) { f.write(reinterpret_cast<const char*>(&v), 4); };
    auto u16 = [&](std::uint16_t v) { f.write(reinterpret_cast<const char*>(&v), 2); };

    f.write("RIFF", 4);  u32(riffBytes);  f.write("WAVE", 4);
    f.write("fmt ", 4);  u32(16);  u16(1);  u16(static_cast<std::uint16_t>(numCh));
    u32(static_cast<std::uint32_t>(sampleRate));  u32(static_cast<std::uint32_t>(byteRate));
    u16(static_cast<std::uint16_t>(blockAlign));  u16(static_cast<std::uint16_t>(bitsPerSample));
    f.write("data", 4);  u32(dataBytes);

    auto clamp16 = [](float v) -> std::int16_t {
        const float c = std::max(-1.0f, std::min(1.0f, v));
        return static_cast<std::int16_t>(std::lrint(c * 32767.0f));
    };
    for (std::size_t i = 0; i < n; ++i)
    {
        const std::int16_t l = clamp16(L[i]);
        const std::int16_t r = clamp16(R[i]);
        f.write(reinterpret_cast<const char*>(&l), 2);
        f.write(reinterpret_cast<const char*>(&r), 2);
    }
}

// ─── Signal helpers ───────────────────────────────────────────────────────────

static void setHallStd(XlethReverbEffect& fx)
{
    fx.setParameterValue("decay",     2.0f);
    fx.setParameterValue("predelay",  0.0f);
    fx.setParameterValue("size",      50.0f);
    fx.setParameterValue("damping",   50.0f);
    fx.setParameterValue("mod_rate",  0.0f);
    fx.setParameterValue("mod_depth", 0.0f);
    fx.setParameterValue("er_level",  100.0f);
    fx.setParameterValue("er_late",   100.0f);
    fx.setParameterValue("hicut",     20000.0f);
    fx.setParameterValue("locut",     20.0f);
    fx.setParameterValue("mix",       100.0f);
    fx.setParameterValue("smoothness", 0.0f);
    fx.setParameterValue("style",     3.0f);   // Hall
}

// Impulse → stereo tail (matches test_reverb::runImpulseStereo geometry).
static void hallImpulseStereo(std::vector<float>& L, std::vector<float>& R,
                              float smoothPct = 0.0f,
                              int kBlocks = 24, double sr = 48000.0, int kBS = 512)
{
    XlethReverbEffect fx;
    setHallStd(fx);
    fx.setParameterValue("smoothness", smoothPct);
    fx.prepareToPlay(sr, kBS);
    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    buf.clear();
    buf.setSample(0, 0, 0.5f);
    buf.setSample(1, 0, 0.5f);
    fx.processBlock(buf, midi);
    for (int s = 0; s < kBS; ++s) { L.push_back(buf.getSample(0, s)); R.push_back(buf.getSample(1, s)); }
    for (int b = 1; b < kBlocks; ++b)
    {
        buf.clear();
        fx.processBlock(buf, midi);
        for (int s = 0; s < kBS; ++s) { L.push_back(buf.getSample(0, s)); R.push_back(buf.getSample(1, s)); }
    }
}

static double crestFactor(const std::vector<float>& v, std::size_t a, std::size_t b)
{
    double peak = 0.0, sumSq = 0.0; std::size_t cnt = 0;
    const std::size_t n = std::min(b, v.size());
    for (std::size_t i = a; i < n; ++i) { const double x = std::abs((double)v[i]); if (x > peak) peak = x; sumSq += (double)v[i]*(double)v[i]; ++cnt; }
    if (!cnt) return 0.0;
    const double rms = std::sqrt(sumSq / (double)cnt);
    return rms > 1e-30 ? peak / rms : 0.0;
}

static double lrCorr(const std::vector<float>& L, const std::vector<float>& R, std::size_t a, std::size_t b)
{
    const std::size_t n = std::min({b, L.size(), R.size()});
    if (n <= a + 1) return 0.0;
    double sL=0,sR=0; for (std::size_t i=a;i<n;++i){sL+=L[i];sR+=R[i];}
    const double mL=sL/(double)(n-a), mR=sR/(double)(n-a);
    double cov=0,vL=0,vR=0;
    for (std::size_t i=a;i<n;++i){const double dL=L[i]-mL,dR=R[i]-mR;cov+=dL*dR;vL+=dL*dL;vR+=dR*dR;}
    if (vL<1e-30||vR<1e-30) return 0.0;
    return cov/std::sqrt(vL*vR);
}

// Deterministic pink noise (matches test_reverb's calibration generator).
struct Pink { std::mt19937 rng; std::array<float,7> b{}; explicit Pink(unsigned s):rng(s){} };
static void fillPink(juce::AudioBuffer<float>& buf, Pink& st)
{
    std::uniform_real_distribution<float> d(-1.f,1.f);
    for (int s=0;s<buf.getNumSamples();++s){
        const float w=d(st.rng);
        st.b[0]=0.99886f*st.b[0]+w*0.0555179f; st.b[1]=0.99332f*st.b[1]+w*0.0750759f;
        st.b[2]=0.96900f*st.b[2]+w*0.1538520f; st.b[3]=0.86650f*st.b[3]+w*0.3104856f;
        st.b[4]=0.55000f*st.b[4]+w*0.5329522f; st.b[5]=-0.7616f*st.b[5]-w*0.0168980f;
        const float pink=st.b[0]+st.b[1]+st.b[2]+st.b[3]+st.b[4]+st.b[5]+st.b[6]+w*0.5362f;
        st.b[6]=w*0.115926f; const float v=pink*0.05f;
        buf.setSample(0,s,v); if (buf.getNumChannels()>1) buf.setSample(1,s,v);
    }
}

static double calibrationWetRms(double sr = 44100.0)
{
    constexpr int kBS = 512;
    const int total = (int)(4.0*sr/kBS), skip = (int)(2.0*sr/kBS);
    XlethReverbEffect fx;
    fx.setParameterValue("decay",2.0f); fx.setParameterValue("predelay",0.0f);
    fx.setParameterValue("size",50.0f); fx.setParameterValue("damping",50.0f);
    fx.setParameterValue("mod_rate",0.0f); fx.setParameterValue("mod_depth",0.0f);
    fx.setParameterValue("er_level",100.0f); fx.setParameterValue("er_late",100.0f);
    fx.setParameterValue("hicut",20000.0f); fx.setParameterValue("locut",20.0f);
    fx.setParameterValue("mix",100.0f); fx.setParameterValue("style",3.0f);
    fx.setParameterValue("smoothness",1.0f);
    fx.prepareToPlay(sr,kBS);
    juce::AudioBuffer<float> buf(2,kBS); juce::MidiBuffer midi; Pink pink(0x51E7u);
    double sumSq=0.0; long long cnt=0;
    for (int b=0;b<total;++b){ fillPink(buf,pink); fx.processBlock(buf,midi);
        if (b>=skip) for (int ch=0;ch<2;++ch) for (int s=0;s<kBS;++s){const double v=buf.getSample(ch,s); sumSq+=v*v; ++cnt;} }
    return cnt? std::sqrt(sumSq/(double)cnt):0.0;
}

static double estimateRT60(double sr, float decay)
{
    constexpr int kBS = 512;
    XlethReverbEffect fx;
    fx.setParameterValue("style",3.0f); fx.setParameterValue("decay",decay);
    fx.setParameterValue("size",50.0f); fx.setParameterValue("damping",0.0f);
    fx.setParameterValue("smoothness",0.0f); fx.setParameterValue("mod_depth",0.0f);
    fx.setParameterValue("mod_rate",0.0f); fx.setParameterValue("er_level",0.0f);
    fx.setParameterValue("er_late",100.0f); fx.setParameterValue("predelay",0.0f);
    fx.setParameterValue("hicut",20000.0f); fx.setParameterValue("locut",20.0f);
    fx.setParameterValue("mix",100.0f);
    fx.prepareToPlay(sr,kBS);
    const double dur=3.0; const int kBlocks=(int)((sr*dur)/kBS);
    std::vector<double> envDb, envT;
    juce::AudioBuffer<float> buf(2,kBS); juce::MidiBuffer midi;
    auto push=[&](int blk){ double sq=0; for(int s=0;s<kBS;++s){const double v=buf.getSample(0,s); sq+=v*v;} const double rms=std::sqrt(sq/kBS); envDb.push_back(20.0*std::log10(rms>1e-30?rms:1e-30)); envT.push_back((blk+0.5)*kBS/sr); };
    buf.clear(); buf.setSample(0,0,0.5f); buf.setSample(1,0,0.5f); fx.processBlock(buf,midi); push(0);
    for (int b=1;b<kBlocks;++b){ buf.clear(); fx.processBlock(buf,midi); push(b); }
    const int startBlk=(int)(0.03*sr/kBS)+1; std::size_t peakBlk=(std::size_t)startBlk; double peakDb=-1e9;
    for (std::size_t i=(std::size_t)startBlk;i<envDb.size();++i) if (envDb[i]>peakDb){peakDb=envDb[i];peakBlk=i;}
    double n=0,sx=0,sy=0,sxx=0,sxy=0;
    for (std::size_t i=peakBlk;i<envDb.size();++i){ if (envDb[i]<peakDb-50.0) break; const double x=envT[i],y=envDb[i]; n+=1;sx+=x;sy+=y;sxx+=x*x;sxy+=x*y; }
    if (n<2) return 0.0; const double den=n*sxx-sx*sx; if (std::abs(den)<1e-18) return 0.0;
    const double slope=(n*sxy-sx*sy)/den; if (slope>=-1e-6) return 1e6; return -60.0/slope;
}

// ─── Musical renders ──────────────────────────────────────────────────────────
// Preset for the A/B renders (stated so before/after use the identical setting):
//   decay 2.6s, size 58, damping 42, er_level 55, er_late 60, mod default
//   (rate 30 / depth 20), mix 35 (audible dry+wet blend), 44.1 kHz.
static void applyRenderPreset(XlethReverbEffect& fx)
{
    fx.setParameterValue("style",3.0f);
    fx.setParameterValue("decay",2.6f);
    fx.setParameterValue("predelay",12.0f);
    fx.setParameterValue("size",58.0f);
    fx.setParameterValue("damping",42.0f);
    fx.setParameterValue("mod_rate",30.0f);
    fx.setParameterValue("mod_depth",20.0f);
    fx.setParameterValue("er_level",55.0f);
    fx.setParameterValue("er_late",60.0f);
    fx.setParameterValue("hicut",12000.0f);
    fx.setParameterValue("locut",80.0f);
    fx.setParameterValue("mix",35.0f);
    fx.setParameterValue("smoothness",0.0f);
}

static void renderThrough(XlethReverbEffect& fx, const std::vector<float>& dryMono,
                          std::vector<float>& L, std::vector<float>& R,
                          double sr, int kBS = 512)
{
    (void)sr;
    juce::AudioBuffer<float> buf(2,kBS); juce::MidiBuffer midi;
    std::size_t pos=0; const std::size_t n=dryMono.size();
    while (pos < n)
    {
        const int block = (int)std::min((std::size_t)kBS, n - pos);
        buf.clear();
        for (int s=0;s<block;++s){ buf.setSample(0,s,dryMono[pos+s]); buf.setSample(1,s,dryMono[pos+s]); }
        // zero-pad the final short block already handled by clear()
        juce::AudioBuffer<float> proc(buf.getArrayOfWritePointers(), 2, kBS);
        fx.processBlock(proc, midi);
        for (int s=0;s<kBS;++s){ L.push_back(buf.getSample(0,s)); R.push_back(buf.getSample(1,s)); }
        pos += (std::size_t)kBS;
        if (block < kBS) break; // last (padded) block emitted
    }
}

int main(int argc, char** argv)
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    const std::string prefix = argc > 1 ? argv[1] : "hall";
    const double sr = 48000.0;

    std::cout << "=== Hall measurement (" << prefix << ") ===\n";

    // 1. Crest factor (smoothness=0 — matches testHallTailCrestFactorBounded).
    std::vector<float> hL, hR;
    hallImpulseStereo(hL, hR, 0.0f, 24, sr, 512);
    const std::size_t a = 4u*512u, b = hL.size();
    const double crest = crestFactor(hL, a, b);
    std::cout << "crest_factor(sm0)  = " << crest << "\n";

    // Onset echo-density (impulse, first ~21 ms window, smoothness=0).
    const double onsetCrest = crestFactor(hL, 0, 1024);
    std::cout << "onset_crest(sm0)   = " << onsetCrest << "\n";

    // 2. Stereo correlation at smoothness=50 — the EXACT condition
    //    testHallStereoDecorrelation asserts against (runImpulseStereo(3,50)).
    std::vector<float> sL, sR;
    hallImpulseStereo(sL, sR, 50.0f, 24, sr, 512);
    const double corr50 = std::abs(lrCorr(sL, sR, a, sL.size()));
    double sumSqR=0.0; for (std::size_t i=a;i<sL.size();++i) sumSqR += (double)sR[i]*sR[i];
    std::cout << "stereo_abs_corr(sm50, TEST cond) = " << corr50 << "\n";
    std::cout << "stereo_abs_corr(sm0)             = " << std::abs(lrCorr(hL, hR, a, b)) << "\n";
    std::cout << "right_energy(sm50) = " << sumSqR << "\n";

    // 3. Calibration wet RMS (44.1 kHz, pink noise, calibration preset).
    const double wetRms = calibrationWetRms(44100.0);
    std::cout << "calibration_wetRMS = " << wetRms << "\n";

    // 4. RT60 vs knob at 44.1k and 48k.
    const float knobs[] = {0.1f,0.3f,1.0f,3.0f,10.0f,30.0f};
    for (double r : {44100.0, 48000.0})
    {
        std::cout << "RT60@" << (int)r << "     =";
        for (float k : knobs) std::cout << " " << k << "s->" << estimateRT60(r,k);
        std::cout << "\n";
    }

    // 5. Render A/B snippets @ 44.1 kHz.
    const double rsr = 44100.0;
    // (a) transient-rich: 6 sharp clicks 180 ms apart, then 2.5 s tail.
    {
        std::vector<float> dry((std::size_t)(rsr*4.0), 0.0f);
        for (int k=0;k<6;++k){ const std::size_t p=(std::size_t)(k*0.18*rsr); if (p<dry.size()) dry[p]=0.9f; if (p+1<dry.size()) dry[p+1]=-0.5f; }
        XlethReverbEffect fx; applyRenderPreset(fx); fx.prepareToPlay(rsr,512);
        std::vector<float> L,R; renderThrough(fx,dry,L,R,rsr);
        writeWav16(prefix+"_transient.wav", L, R, (int)rsr);
        std::cout << "wrote " << prefix << "_transient.wav (" << L.size() << " frames)\n";
    }
    // (b) sustained chord: A3+C#4+E4 (major), 1.6 s note + 2.4 s tail, soft env.
    {
        const double freqs[3] = {220.0, 277.18, 329.63};
        std::vector<float> dry((std::size_t)(rsr*4.0), 0.0f);
        const std::size_t noteLen=(std::size_t)(rsr*1.6);
        for (std::size_t i=0;i<dry.size();++i){
            double s=0.0; const double t=i/rsr;
            if (i<noteLen){ for (double f:freqs) s+=std::sin(2.0*juce::MathConstants<double>::pi*f*t); s/=3.0;
                const double env = std::min(1.0,(double)i/(0.02*rsr)) * std::min(1.0,(double)(noteLen-i)/(0.05*rsr));
                s*=env*0.6; }
            dry[i]=(float)s;
        }
        XlethReverbEffect fx; applyRenderPreset(fx); fx.prepareToPlay(rsr,512);
        std::vector<float> L,R; renderThrough(fx,dry,L,R,rsr);
        writeWav16(prefix+"_chord.wav", L, R, (int)rsr);
        std::cout << "wrote " << prefix << "_chord.wav (" << L.size() << " frames)\n";
    }

    std::cout << "=== done ===\n";
    return 0;
}
