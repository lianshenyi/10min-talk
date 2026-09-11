'use client';

import {
  ArrowRight,
  Archive,
  Eraser,
  Check,
  CirclePause,
  CirclePlay,
  Download,
  ExternalLink,
  Headphones,
  Keyboard,
  Mic,
  RotateCcw,
  Search,
  Sparkles,
  Square,
  Settings,
  Volume2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { domains, terms } from '@/data/terms';
import { requestResearchBrief } from '@/lib/ai';
import { initialResearchAiState, type ResearchAiState } from '@/lib/research-ai';
import { readDrawHistory } from '@/lib/draw-history';
import { clearCurrentSession, deleteAudio, loadCurrentSession, saveAudio, saveCurrentSession, saveHistory } from '@/lib/local-repository';
import { loadHistory, loadPersonalTerms } from '@/lib/local-repository';
import { AiSettings, EvaluationPanel, HistoryPanel, WikipediaPanel } from '@/components/phase-three';
import { collectRecognitionUpdate } from '@/lib/transcript';
import { loadSessionConfig } from '@/lib/secure-config';
import type { AiConfig, HistoryEntry, LearningSession, Phase, TermCard } from '@/lib/types';

const RESEARCH_MS = 10 * 60 * 1000;
const PREPARE_MS = 3 * 1000;
const HISTORY_KEY = 'ten-minute-knowledge-cards:draw-history';

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

type RecognitionConstructor = new () => Recognition;

declare global {
  interface Window {
    webkitSpeechRecognition?: RecognitionConstructor;
    SpeechRecognition?: RecognitionConstructor;
  }
}

const formatClock = (seconds: number) => {
  const safe = Math.max(0, seconds);
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
};

const createSession = (term: TermCard, outputSeconds: 180 | 300): LearningSession => ({
  id: crypto.randomUUID(),
  termId: term.id,
  phase: 'draw',
  outputSeconds,
  transcript: '',
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const getMimeType = () =>
  ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));

export function LearningApp() {
  const [selectedDomain, setSelectedDomain] = useState('全部领域');
  const [term, setTerm] = useState<TermCard>(terms[0]);
  const [session, setSession] = useState<LearningSession>(() => createSession(terms[0], 180));
  const [remainingSeconds, setRemainingSeconds] = useState(10 * 60);
  const [isPaused, setIsPaused] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [notice, setNotice] = useState('');
  const [isHydrated, setIsHydrated] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [rouletteTerms, setRouletteTerms] = useState<TermCard[]>([]);
  const [personalTerms, setPersonalTerms] = useState<TermCard[]>([]);
  const [aiConfig, setAiConfig] = useState<AiConfig | null>(null);
  const [aiConfigVersion, setAiConfigVersion] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const mediaStream = useRef<MediaStream | null>(null);
  const rouletteSound = useRef<HTMLAudioElement | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const chunks = useRef<Blob[]>([]);
  const finalizedRecognitionIndices = useRef(new Set<number>());
  const discardPendingRecording = useRef(false);

  const phase = session.phase;
  const activeTerms = useMemo(
    () => {
      const allTerms = [...terms, ...personalTerms];
      return selectedDomain === '全部领域' ? allTerms : allTerms.filter((item) => item.domain === selectedDomain);
    },
    [personalTerms, selectedDomain],
  );

  const updateSession = useCallback((next: LearningSession) => {
    const withTimestamp = { ...next, updatedAt: Date.now() };
    setSession(withTimestamp);
    saveCurrentSession(withTimestamp);
  }, []);

  const setPhase = useCallback((nextPhase: Phase, timing?: { durationMs: number }) => {
    setSession((current) => {
      const next = {
        ...current,
        phase: nextPhase,
        deadlineAt: timing ? Date.now() + timing.durationMs : undefined,
        pausedRemainingMs: undefined,
        updatedAt: Date.now(),
      };
      saveCurrentSession(next);
      return next;
    });
    setIsPaused(false);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const unlockedConfig = loadSessionConfig();
      if (unlockedConfig) {
        setAiConfig(unlockedConfig);
        setAiConfigVersion((version) => version + 1);
      }
      const stored = loadCurrentSession();
      if (stored) {
        const storedTerm = terms.find((item) => item.id === stored.termId);
        if (storedTerm) {
          setTerm(storedTerm);
          setSession(stored);
          setHasDrawn(true);
          if (stored.pausedRemainingMs) setRemainingSeconds(Math.ceil(stored.pausedRemainingMs / 1000));
        }
      }
      void loadPersonalTerms().then(setPersonalTerms).catch(() => setNotice('无法读取个人词库。'));
      void loadHistory().then(setHistory).catch(() => setNotice('无法读取本地历史。'));
      setIsHydrated(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const stopTracks = useCallback(() => {
    mediaStream.current?.getTracks().forEach((track) => track.stop());
    mediaStream.current = null;
  }, []);

  const stopRecording = useCallback(() => {
    recognition.current?.stop();
    if (mediaRecorder.current?.state === 'recording') mediaRecorder.current.stop();
    else stopTracks();
    setIsRecording(false);
  }, [stopTracks]);

  const completeRecording = useCallback(async () => {
    if (discardPendingRecording.current) {
      chunks.current = [];
      return;
    }
    const blob = new Blob(chunks.current, { type: mediaRecorder.current?.mimeType || 'audio/webm' });
    if (!blob.size) return;
    const id = crypto.randomUUID();
    const nextUrl = URL.createObjectURL(blob);
    setAudioUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return nextUrl;
    });
    try {
      await saveAudio({ id, blob, mimeType: blob.type, createdAt: Date.now() });
      setSession((current) => {
        const next = { ...current, audioId: id, updatedAt: Date.now() };
        saveCurrentSession(next);
        return next;
      });
    } catch {
      setNotice('音频可在本次页面回放，但浏览器没有保存它。请检查存储空间或隐私模式设置。');
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setNotice('此浏览器不支持录音。你仍可直接输入口述稿。');
      setPhase('transcript');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      discardPendingRecording.current = false;
      mediaStream.current = stream;
      const mimeType = getMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks.current = [];
      finalizedRecognitionIndices.current.clear();
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data); };
      recorder.onstop = () => { void completeRecording(); stopTracks(); };
      recorder.start(1000);
      mediaRecorder.current = recorder;
      setIsRecording(true);
      const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        const speech = new SpeechRecognition();
        speech.lang = 'zh-CN';
        speech.continuous = true;
        speech.interimResults = true;
        speech.onresult = (event) => {
          const { finalText, interimText } = collectRecognitionUpdate(event.results, event.resultIndex, finalizedRecognitionIndices.current);
          if (finalText) setSession((current) => ({ ...current, transcript: `${current.transcript}${finalText}`, updatedAt: Date.now() }));
          setInterimTranscript(interimText);
        };
        speech.onend = () => { if (mediaRecorder.current?.state === 'recording') { try { speech.start(); } catch { /* browser already restarted */ } } };
        speech.onerror = () => setNotice('实时转写已停止；录音仍在继续，你可以稍后手动整理稿件。');
        recognition.current = speech;
        speech.start();
      }
    } catch {
      setNotice('未获得麦克风权限。你仍可手动输入口述稿。');
      setPhase('transcript');
    }
  }, [completeRecording, setPhase, stopTracks]);

  const advance = useCallback(() => {
    if (phase === 'research') setPhase('prepare', { durationMs: PREPARE_MS });
    else if (phase === 'prepare') setPhase('speak', { durationMs: session.outputSeconds * 1000 });
    else if (phase === 'speak') { stopRecording(); setPhase('transcript'); }
  }, [phase, session.outputSeconds, setPhase, stopRecording]);

  useEffect(() => {
    if (!['research', 'prepare', 'speak'].includes(phase)) return;
    const refresh = () => {
      const deadline = session.deadlineAt;
      const remainingMs = isPaused ? (session.pausedRemainingMs ?? 0) : Math.max(0, (deadline ?? Date.now()) - Date.now());
      const seconds = Math.ceil(remainingMs / 1000);
      setRemainingSeconds(seconds);
      if (!isPaused && remainingMs <= 0) advance();
    };
    refresh();
    const interval = window.setInterval(refresh, 250);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', refresh); };
  }, [advance, isPaused, phase, session.deadlineAt, session.pausedRemainingMs]);

  useEffect(() => {
    if (phase !== 'speak' || isRecording) return;
    const timeout = window.setTimeout(() => { void startRecording(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [isRecording, phase, startRecording]);

  useEffect(() => () => { stopRecording(); if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl, stopRecording]);

  const drawTerm = useCallback(() => {
    if (isDrawing) return;
    let history: string[] = [];
    try { history = readDrawHistory(window.localStorage.getItem(HISTORY_KEY)); } catch { /* Private browsing can deny storage access. */ }
    const eligible = activeTerms.filter((item) => !history.includes(item.id));
    const pool = eligible.length ? eligible : activeTerms;
    const next = pool[Math.floor(Math.random() * pool.length)] ?? terms[0];
    const nextHistory = [next.id, ...history.filter((id) => id !== next.id)].slice(0, 20);
    try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory)); } catch { setNotice('浏览器未保存抽卡历史，本次抽卡仍可继续。'); }
    const rollingItems = Array.from({ length: 11 }, () => activeTerms[Math.floor(Math.random() * activeTerms.length)] ?? next);
    setRouletteTerms([...rollingItems, next]);
    setIsDrawing(true);
    setNotice('');
    const audio = rouletteSound.current;
    if (audio) {
      audio.currentTime = 0;
      audio.muted = false;
      audio.volume = 1;
      void audio.play().catch(() => {
        setNotice('提示音被浏览器阻止播放。请确认此标签页未静音后重试。');
      });
    }
    window.setTimeout(() => {
      const nextSession = createSession(next, session.outputSeconds);
      setTerm(next);
      setSession(nextSession);
      saveCurrentSession(nextSession);
      setHasDrawn(true);
      setIsDrawing(false);
    }, 2800);
  }, [activeTerms, isDrawing, session.outputSeconds]);

  const togglePause = () => {
    if (isPaused) {
      const duration = session.pausedRemainingMs ?? 0;
      updateSession({ ...session, deadlineAt: Date.now() + duration, pausedRemainingMs: undefined });
      setIsPaused(false);
    } else {
      const remainingMs = Math.max(0, (session.deadlineAt ?? Date.now()) - Date.now());
      updateSession({ ...session, deadlineAt: undefined, pausedRemainingMs: remainingMs });
      setIsPaused(true);
    }
  };

  const startResearch = () => {
    const next = { ...session, phase: 'research' as const, deadlineAt: Date.now() + RESEARCH_MS, pausedRemainingMs: undefined };
    updateSession(next);
    setRemainingSeconds(600);
  };

  const savePractice = async () => {
    try {
      const entry = { ...session, phase: 'completed' as const, updatedAt: Date.now(), savedAt: Date.now() };
      await saveHistory(entry);
      clearCurrentSession();
      setSession(entry);
      setNotice('本次练习已保存在此浏览器。');
    } catch {
      setNotice('浏览器未能保存练习记录。请复制稿件后再继续。');
    }
  };

  const clearCurrentPractice = async () => {
    discardPendingRecording.current = true;
    stopRecording();
    if (session.audioId) {
      try { await deleteAudio(session.audioId); } catch { /* The visible state can still be safely reset. */ }
    }
    setAudioUrl((current) => { if (current) URL.revokeObjectURL(current); return null; });
    clearCurrentSession();
    setTerm(terms[0]);
    setSession(createSession(terms[0], session.outputSeconds));
    setHasDrawn(false);
    setIsDrawing(false);
    setInterimTranscript('');
    setIsPaused(false);
    setNotice('已清除本轮未保存的练习；历史、词库和 AI 设置均未改变。');
  };

  if (!isHydrated) return <main className="app-shell" />;

  return (
    <main className="app-shell">
      <audio ref={rouletteSound} preload="auto" playsInline src="/roulette-spin.wav" onError={() => setNotice('提示音资源加载失败。请刷新页面后重试。')}><track kind="captions" /></audio>
      <nav className="topbar" aria-label="主导航">
        <div className="brand"><span className="brand-mark">十</span><span>拾分钟</span><small>知识卡</small></div>
        <div className="phase-rail" aria-label="学习进度">
          {['抽卡', '研究', '口述', '复盘'].map((label, index) => <span className={index <= (phase === 'draw' ? 0 : phase === 'research' ? 1 : phase === 'prepare' || phase === 'speak' ? 2 : 3) ? 'active' : ''} key={label}>{label}</span>)}
        </div>
        <div className="top-actions"><button onClick={() => void clearCurrentPractice()} aria-label="清除本轮未保存练习" title="清除本轮"><Eraser size={17} /></button><button onClick={() => setShowHistory(true)} aria-label="打开历史"><Archive size={17} /></button><button onClick={() => setShowSettings(true)} aria-label="打开 AI 设置"><Settings size={17} /></button><span className="local-pill"><span />仅本地保存</span></div>
      </nav>

      <section className="workspace">
        <aside className="side-panel">
          <p className="eyebrow">本次练习</p>
          <h1>{phase === 'draw' ? '选择一个值得想透的问题' : term.title}</h1>
          <div className="duration-control" aria-label="口述时长">
            <span>口述</span>
            {[180, 300].map((seconds) => <button className={session.outputSeconds === seconds ? 'selected' : ''} key={seconds} onClick={() => setSession((current) => ({ ...current, outputSeconds: seconds as 180 | 300 }))}>{seconds / 60} 分钟</button>)}
          </div>
          <div className="domain-list">
            <p className="eyebrow">探索领域</p>
            {domains.map((domain) => <button key={domain} className={domain === selectedDomain ? 'selected' : ''} onClick={() => { setSelectedDomain(domain); }}><span>{domain}</span>{domain === selectedDomain && <Check size={14} />}</button>)}
          </div>
        </aside>

        <section className="main-stage">
          {phase === 'draw' && !hasDrawn && <EmptyDrawStage onDraw={drawTerm} />}
          {phase === 'draw' && isDrawing && <RouletteStage terms={rouletteTerms} />}
          {phase === 'draw' && hasDrawn && !isDrawing && <DrawStage term={term} onDraw={drawTerm} onStart={startResearch} />}
          {phase === 'research' && <ResearchStage term={term} seconds={remainingSeconds} paused={isPaused} onPause={togglePause} onFinish={advance} aiConfig={aiConfig} aiConfigVersion={aiConfigVersion} onOpenAiSettings={() => setShowSettings(true)} />}
          {phase === 'prepare' && <PrepareStage seconds={remainingSeconds} />}
          {phase === 'speak' && <SpeakStage term={term} seconds={remainingSeconds} transcript={session.transcript} interim={interimTranscript} isRecording={isRecording} onStop={advance} />}
          {(phase === 'transcript' || phase === 'completed') && <TranscriptStage term={term} session={session} audioUrl={audioUrl} onChange={(transcript) => updateSession({ ...session, transcript })} onSave={savePractice} onAgain={() => { stopRecording(); setSession(createSession(term, session.outputSeconds)); setAudioUrl(null); setPhase('prepare', { durationMs: PREPARE_MS }); }} saved={phase === 'completed'} aiConfig={aiConfig} onEvaluation={(evaluation) => updateSession({ ...session, evaluation })} />}
          {notice && <output className="notice">{notice}</output>}
        </section>
      </section>
      {phase === 'draw' && hasDrawn && !isDrawing && <div className="wiki-drawer"><WikipediaPanel onAdd={(item) => setPersonalTerms((current) => [...current.filter((termItem) => termItem.id !== item.id), item])} /></div>}
      {showSettings && <AiSettings onReady={(config) => { setAiConfig(config); setAiConfigVersion((version) => version + 1); }} onClose={() => setShowSettings(false)} />}
      {showHistory && <HistoryPanel entries={history} onDelete={(entry) => setHistory((current) => current.filter((item) => item.id !== entry.id))} onClose={() => setShowHistory(false)} />}
      <footer><Keyboard size={14} /> 抽卡时可使用 ← / → 换卡。录音、学习记录与 AI 配置只留在当前浏览器。</footer>
    </main>
  );
}

function EmptyDrawStage({ onDraw }: { onDraw: () => void }) {
  return <div className="empty-draw-stage"><div className="empty-deck" aria-hidden="true"><span /><span /><span /></div><p className="eyebrow">准备开始</p><h2>这一轮，学点什么？</h2><p>抽取一个跨领域概念，用十分钟把它研究明白。</p><button className="primary-action draw-button" onClick={onDraw}><Sparkles size={18} />抽取本次卡片</button></div>;
}

function RouletteStage({ terms: rollingTerms }: { terms: TermCard[] }) {
  return <div className="roulette-stage" aria-live="polite"><p className="eyebrow">正在抽取</p><h2>让灵感转一会儿</h2><div className="roulette-window"><div className="roulette-marker" /><div className="roulette-track">{rollingTerms.map((item, index) => <div className="roulette-item" key={`${item.id}-${index}`}><span>{item.domain}</span><strong>{item.title}</strong><small>{item.kind}</small></div>)}</div></div><p>正在为你选出一个值得想透的问题</p></div>;
}

function DrawStage({ term, onDraw, onStart }: { term: TermCard; onDraw: () => void; onStart: () => void }) {
  const pointerStart = useRef<number | null>(null);
  return <div className="draw-stage"><div className="deck-count">随机牌组 <span>144 个专业词条</span></div><button className="term-card" type="button" aria-label="向左或向右拖动以换一张卡片" onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') onDraw(); }} onPointerDown={(event) => { pointerStart.current = event.clientX; }} onPointerUp={(event) => { const startedAt = pointerStart.current; if (startedAt !== null && Math.abs(event.clientX - startedAt) > 60) onDraw(); pointerStart.current = null; }}><div className="card-top"><span>{term.domain}</span><span>{term.kind}</span></div><div><p className="english">{term.english}</p><h2>{term.title}</h2></div><div className="prompt"><Sparkles size={17} /><p>{term.prompt}</p></div><p className="swipe-hint">左右滑动，或按键盘方向键换一张</p></button><div className="draw-actions"><button className="ghost-action" onClick={onDraw}><RotateCcw size={18} />换一张</button><button className="primary-action" onClick={onStart}>开始 10 分钟研究 <ArrowRight size={18} /></button></div></div>;
}

function ResearchStage({ term, seconds, paused, onPause, onFinish, aiConfig, aiConfigVersion, onOpenAiSettings }: { term: TermCard; seconds: number; paused: boolean; onPause: () => void; onFinish: () => void; aiConfig: AiConfig | null; aiConfigVersion: number; onOpenAiSettings: () => void }) {
  return <div className="focus-stage"><p className="eyebrow">研究时间</p><div className="timer">{formatClock(seconds)}</div><h2>研究「{term.title}」</h2><p className="focus-prompt">带着这个问题阅读：{term.prompt}</p><div className="source-grid">{term.sources.map((source) => <a href={source.url} target="_blank" rel="noreferrer" key={source.label}><Search size={17} /><span>{source.label}</span><ExternalLink size={14} /></a>)}</div><AiResearchBrief key={`${term.id}-${aiConfigVersion}`} term={term} config={aiConfig} onOpenSettings={onOpenAiSettings} /><div className="draw-actions"><button className="ghost-action" onClick={onPause}>{paused ? <CirclePlay size={18} /> : <CirclePause size={18} />}{paused ? '继续研究' : '暂停'}</button><button className="primary-action" onClick={onFinish}>结束研究，准备口述 <ArrowRight size={18} /></button></div></div>;
}

function AiResearchBrief({ term, config, onOpenSettings }: { term: TermCard; config: AiConfig | null; onOpenSettings: () => void }) {
  const [state, setState] = useState<ResearchAiState>(() => initialResearchAiState(Boolean(config)));
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    void requestResearchBrief(config, term).then((brief) => { if (!cancelled) setState({ kind: 'ready', brief }); }).catch((error) => { if (!cancelled) setState({ kind: 'failed', reason: (error as Error).message }); });
    return () => { cancelled = true; };
  }, [config, term]);
  if (state.kind === 'unavailable') return <button className="ai-source ai-source-action" onClick={onOpenSettings}><Sparkles size={17} /><span>AI 研究速览</span><small>配置并解锁后生成</small></button>;
  if (state.kind === 'loading') return <div className="ai-source"><Sparkles size={17} />AI 正在整理…</div>;
  if (state.kind === 'failed') return <button className="ai-source ai-source-action" onClick={onOpenSettings}><Sparkles size={17} /><span>AI 暂时不可用</span><small>{state.reason}</small></button>;
  return <section className="ai-research-brief"><p><Sparkles size={16} />AI 研究速览</p><span>{state.brief}</span></section>;
}

function PrepareStage({ seconds }: { seconds: number }) { return <div className="prepare-stage"><p className="eyebrow">准备口述</p><div className="countdown">{seconds}</div><h2>用自己的话讲清楚</h2><p>不必完美。试着说明概念、举一个例子，再说说它有什么用。</p></div>; }

function SpeakStage({ term, seconds, transcript, interim, isRecording, onStop }: { term: TermCard; seconds: number; transcript: string; interim: string; isRecording: boolean; onStop: () => void }) { return <div className="speak-stage"><p className="eyebrow">正在口述 · {term.title}</p><div className="timer">{formatClock(seconds)}</div><div className="recording-orb"><Mic size={30} /><span /></div><p className="recording-label">{isRecording ? '正在录音' : '正在请求麦克风…'}</p><div className="live-transcript"><p>{transcript || '实时转写会显示在这里；不支持时可稍后手动填写。'}<em>{interim}</em></p></div><button className="stop-action" onClick={onStop}><Square size={15} fill="currentColor" />结束口述</button></div>; }

function TranscriptStage({ term, session, audioUrl, onChange, onSave, onAgain, saved, aiConfig, onEvaluation }: { term: TermCard; session: LearningSession; audioUrl: string | null; onChange: (value: string) => void; onSave: () => void; onAgain: () => void; saved: boolean; aiConfig: AiConfig | null; onEvaluation: (evaluation: NonNullable<LearningSession['evaluation']>) => void }) {
  const download = async () => {
    if (!audioUrl) return;
    const blob = await (await fetch(audioUrl)).blob();
    const extension = blob.type.includes('mp4') ? 'm4a' : 'webm';
    const date = new Date().toLocaleDateString('sv-SE');
    const link = document.createElement('a');
    link.href = audioUrl;
    link.download = `${term.title}-${date}.${extension}`;
    link.click();
  };
  return <div className="transcript-stage"><div><p className="eyebrow">复盘与保存</p><h2>你如何解释「{term.title}」？</h2></div>{audioUrl ? <div className="audio-player"><Headphones size={18} /><audio controls src={audioUrl}><track kind="captions" /></audio><button className="download-audio" onClick={() => void download()}><Download size={16} />下载</button></div> : <p className="audio-empty"><Volume2 size={17} />没有可回放的录音；稿件仍可保存。</p>}<label htmlFor="transcript">口述稿</label><textarea id="transcript" value={session.transcript} onChange={(event) => onChange(event.target.value)} placeholder="录音转写会出现于此，也可以直接粘贴或编辑你的口述稿。" /><EvaluationPanel config={aiConfig} term={term} transcript={session.transcript} onResult={onEvaluation} /><div className="draw-actions"><button className="ghost-action" onClick={onAgain}><RotateCcw size={18} />重新口述</button><button className="primary-action" onClick={onSave} disabled={saved}>{saved ? <><Check size={18} />已保存</> : <>保存本次练习 <ArrowRight size={18} /></>}</button></div></div>;
}
