'use client';

import { Download, KeyRound, Search, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { listModels, requestEvaluation, verifyAiKey } from '@/lib/ai';
import { terms } from '@/data/terms';
import { clearConfig, loadEncryptedConfig, saveConfig, unlockConfig } from '@/lib/secure-config';
import { deleteHistory, savePersonalTerm } from '@/lib/local-repository';
import { searchWikipedia } from '@/lib/wikipedia';
import type { AiConfig, EvaluationResult, HistoryEntry, TermCard } from '@/lib/types';

const presets = {
  deepseek: { label: 'DeepSeek API', provider: 'openai' as const, endpoint: 'https://api.deepseek.com/chat/completions', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
  minimaxCn: { label: 'MiniMax 国内 Token Plan', provider: 'anthropic' as const, endpoint: 'https://api.minimaxi.com/anthropic/v1/messages', models: ['MiniMax-M2.7-highspeed', 'MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.5'] },
  minimaxIntl: { label: 'MiniMax 国际 Token Plan', provider: 'anthropic' as const, endpoint: 'https://api.minimax.io/anthropic/v1/messages', models: ['MiniMax-M2.7-highspeed', 'MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.1-highspeed', 'MiniMax-M2.1'] },
};

export function AiSettings({ onReady, onClose }: { onReady: (config: AiConfig | null) => void; onClose: () => void }) {
  const saved = loadEncryptedConfig();
  const isLegacyMiniMaxIntl = saved?.endpoint === '/minimax-intl/anthropic/v1/messages' || saved?.endpoint === 'https://api.minimax.io/v1/chat/completions' || saved?.endpoint === 'https://api.minimax.io/anthropic/v1/messages';
  const isLegacyMiniMaxCn = saved?.endpoint === '/minimax-cn/anthropic/v1/messages' || saved?.endpoint === 'https://api.minimaxi.com/anthropic/v1/messages';
  const initialService = saved?.endpoint === presets.deepseek.endpoint ? 'deepseek' : saved?.endpoint === presets.minimaxCn.endpoint || isLegacyMiniMaxCn ? 'minimaxCn' : saved?.endpoint === presets.minimaxIntl.endpoint || isLegacyMiniMaxIntl ? 'minimaxIntl' : saved?.provider === 'anthropic' ? 'custom-anthropic' : 'custom-openai';
  const initialPreset = initialService === 'deepseek' || initialService === 'minimaxCn' || initialService === 'minimaxIntl' ? presets[initialService] : null;
  const [service, setService] = useState<'deepseek' | 'minimaxCn' | 'minimaxIntl' | 'custom-openai' | 'custom-anthropic'>(initialService);
  const [provider, setProvider] = useState<'openai' | 'anthropic'>(initialPreset?.provider ?? saved?.provider ?? 'openai');
  const [endpoint, setEndpoint] = useState(initialPreset?.endpoint ?? saved?.endpoint ?? '');
  const [model, setModel] = useState(saved?.model ?? initialPreset?.models[0] ?? presets.deepseek.models[0]);
  const [apiKey, setApiKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [message, setMessage] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[] | null>(null);
  const selectService = (next: typeof service) => {
    setService(next);
    const preset = next === 'deepseek' || next === 'minimaxCn' || next === 'minimaxIntl' ? presets[next] : null;
    if (preset) { setProvider(preset.provider); setEndpoint(preset.endpoint); setModel(preset.models[0]); }
    else setProvider(next === 'custom-anthropic' ? 'anthropic' : 'openai');
  };
  const save = async () => {
    try {
      if (!endpoint || !model || !passphrase) throw new Error('请填写服务、模型和本地口令');
      const existing = saved && !apiKey ? await unlockConfig(passphrase) : null;
      const key = apiKey || existing?.apiKey;
      if (!key) throw new Error('请填写 API Key');
      const config = { provider, endpoint, model, apiKey: key };
      await saveConfig(config, passphrase);
      onReady(config);
      setApiKey('');
      setMessage('已加密保存。API Key 不会显示或写入练习记录。');
    } catch (error) { setMessage((error as Error).message); }
  };
  const unlock = async () => { try { const config = await unlockConfig(passphrase); onReady(config); setMessage('已在本次页面解锁。'); } catch (error) { setMessage((error as Error).message); } };
  const currentConfig = async (): Promise<AiConfig> => {
    if (apiKey) return { provider, endpoint, model, apiKey };
    if (saved) {
      const existing = await unlockConfig(passphrase);
      return { provider, endpoint, model, apiKey: existing.apiKey };
    }
    throw new Error('请填写 API Key');
  };
  const test = async () => { setIsTesting(true); setMessage('正在验证 API Key…'); try { const config = await currentConfig(); await verifyAiKey(config); onReady(config); setMessage('API Key 验证成功，已在本次标签页解锁。'); } catch (error) { setMessage((error as Error).message); } finally { setIsTesting(false); } };
  const refreshModels = async () => { try { const config = await currentConfig(); const models = await listModels(config); setAvailableModels(models); if (!models.includes(model)) setModel(models[0]); setMessage(`已获取 ${models.length} 个官方模型。`); } catch (error) { setMessage((error as Error).message); } };
  const selectedPreset = service === 'deepseek' || service === 'minimaxCn' || service === 'minimaxIntl' ? presets[service] : null;
  const modelOptions = availableModels ?? selectedPreset?.models ?? [];
  return <div className="modal-backdrop"><section className="modal-card"><button className="modal-close" onClick={onClose} aria-label="关闭"><X /></button><p className="eyebrow">AI 设置</p><h2>本地加密配置</h2><p className="panel-copy">DeepSeek 与国内/国际 MiniMax 经本站后端转发，以避免浏览器跨域限制；密钥仅随请求转发，不保存在服务端。自定义 Endpoint 需自行支持 CORS。解锁后会在本次标签页临时保留，关闭标签页即清除。</p><div className="form-grid"><label>服务<select value={service} onChange={(event) => { selectService(event.target.value as typeof service); setAvailableModels(null); }}><option value="deepseek">DeepSeek API</option><option value="minimaxCn">MiniMax 国内 Token Plan</option><option value="minimaxIntl">MiniMax 国际 Token Plan</option><option value="custom-openai">自定义 OpenAI-compatible</option><option value="custom-anthropic">自定义 Anthropic Messages</option></select></label>{selectedPreset ? <label>模型<select value={model} onChange={(event) => setModel(event.target.value)}>{modelOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label> : <><label>完整 Endpoint<input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://…/v1/chat/completions" /></label><label>模型<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="例如 gpt-4o-mini" /></label></>}<label>{service === 'minimaxCn' || service === 'minimaxIntl' ? 'MiniMax Token Plan Key' : 'API Key'}<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={saved ? '留空则保持已保存的密钥' : ''} /></label><label>本地口令<input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label></div><div className="panel-actions">{selectedPreset && provider === 'openai' && <button className="ghost-action" onClick={refreshModels}>获取官方模型</button>}<button className="primary-action" onClick={save}><KeyRound size={16} />{saved ? '保存并更新' : '加密保存'}</button>{saved && <button className="ghost-action" onClick={unlock}>仅解锁</button>}<button className="ghost-action" onClick={test} disabled={isTesting}>{isTesting ? '测试中…' : '测试并解锁'}</button> {saved && <button className="ghost-action" onClick={() => { clearConfig(); onReady(null); setMessage('已清除本地 AI 配置。'); }}>清除配置</button>}</div>{message && <output className="notice" aria-live="polite">{message}</output>}</section></div>;
}

export function EvaluationPanel({ config, term, transcript, onResult }: { config: AiConfig | null; term: TermCard; transcript: string; onResult: (value: EvaluationResult) => void }) {
  const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [result, setResult] = useState<EvaluationResult | null>(null);
  const [thinkingDraft, setThinkingDraft] = useState('');
  const [textDraft, setTextDraft] = useState('');
  const thinkingRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const evaluate = async () => {
    if (!config) { setError('请先在 AI 设置中解锁配置。'); return; }
    setLoading(true); setError(''); setResult(null); setThinkingDraft(''); setTextDraft('');
    try {
      const next = await requestEvaluation(config, term, transcript, {
        onThinkingDelta: (delta) => setThinkingDraft((previous) => {
          const updated = previous + delta;
          queueMicrotask(() => { thinkingRef.current?.scrollTo({ top: thinkingRef.current.scrollHeight }); });
          return updated;
        }),
        onTextDelta: (delta) => setTextDraft((previous) => {
          const updated = previous + delta;
          queueMicrotask(() => { textRef.current?.scrollTo({ top: textRef.current.scrollHeight }); });
          return updated;
        }),
      });
      setResult(next);
      onResult(next);
    } catch (reason) { setError((reason as Error).message); }
    finally { setLoading(false); }
  };
  const showStreaming = loading && (thinkingDraft || textDraft);
  return (
    <section className="evaluation">
      <button className="primary-action" onClick={evaluate} disabled={loading}>{loading ? '正在评价…' : '获取 AI 评价'}</button>
      {error && <output className="notice">{error}</output>}
      {showStreaming && (
        <div className="evaluation-streaming">
          {thinkingDraft && <details className="evaluation-thinking" open><summary>AI 思考中</summary><div ref={thinkingRef} className="evaluation-thinking-body"><pre>{thinkingDraft}<span className="cursor" /></pre></div></details>}
          {textDraft && <div className="evaluation-text-draft" ref={textRef}><strong>正在生成评价</strong><pre>{textDraft}<span className="cursor" /></pre></div>}
        </div>
      )}
      {result && (
        <div className="evaluation-result">
          <div className="scores"><span>理解 <b>{result.understanding}/5</b></span><span>表达 <b>{result.expression}/5</b></span><span>应用 <b>{result.application}/5</b></span></div>
          <p>{result.summary}</p>
          <strong>亮点</strong>
          <ul>{result.strengths.map((item) => <li key={item}>{item}</li>)}</ul>
          <strong>下一步</strong>
          <p>{result.nextQuestion}</p>
        </div>
      )}
    </section>
  );
}

export function WikipediaPanel({ onAdd }: { onAdd: (term: TermCard) => void }) {
  const [query, setQuery] = useState(''); const [results, setResults] = useState<TermCard[]>([]); const [message, setMessage] = useState('');
  const search = async () => { try { setResults(await searchWikipedia(query)); setMessage(''); } catch (error) { setMessage((error as Error).message); } };
  return <section className="wiki-panel"><p className="eyebrow">扩展词库</p><div className="search-row"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="在维基百科搜索词条" /><button className="ghost-action" onClick={search}><Search size={16} />搜索</button></div>{results.map((item) => <div className="wiki-result" key={item.id}><div><strong>{item.title}</strong><p>{item.prompt}</p></div><button onClick={async () => { await savePersonalTerm({ ...item, reviewStatus: 'reviewed' }); onAdd({ ...item, reviewStatus: 'reviewed' }); }}>加入词库</button></div>)}{message && <output className="notice">{message}</output>}</section>;
}

export function HistoryPanel({ entries, onDelete, onClose }: { entries: HistoryEntry[]; onDelete: (entry: HistoryEntry) => void; onClose: () => void }) {
  const exportEntries = () => { const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `拾分钟知识卡-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url); };
  return <div className="modal-backdrop"><section className="modal-card history-card"><button className="modal-close" onClick={onClose} aria-label="关闭"><X /></button><p className="eyebrow">本地历史</p><h2>练习记录</h2><button className="ghost-action" onClick={exportEntries}><Download size={16} />导出 JSON</button>{entries.length ? <div className="history-list">{[...entries].sort((a, b) => b.savedAt - a.savedAt).map((entry) => <div key={entry.id}><span>{new Date(entry.savedAt).toLocaleDateString('zh-CN')}</span><strong>{terms.find((term) => term.id === entry.termId)?.title ?? entry.termId}</strong><button onClick={async () => { await deleteHistory(entry); onDelete(entry); }} aria-label="删除记录"><Trash2 size={16} /></button></div>)}</div> : <p className="panel-copy">还没有保存的练习。</p>}</section></div>;
}
