import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Activity, Bookmark, ArrowRight, ArrowUp, Check, ChevronDown, ChevronRight, CircleHelp, Copy, Download, ExternalLink, Focus, GitBranch, Globe2, Layers2, Loader2, Maximize2, MessageCircle, Minus, PanelRightClose, Pin, Plus, RefreshCw, Search, Square, Users, X, Reddit, Twitter, Linkedin, Database } from './icons';
import { AtlasGraph } from './Graph';
import { api, niceDate, sourceName, download } from './api';
import type { AgentInfo, AtlasState, Draft, GraphHandle, Lead, Message, NodeSearchResponse, SavedProblem, Signal, Source, SourceHealth, View } from './types';
import { citedSourceIds, canonicalSourceUrl } from '../shared/citations.mjs';
import { createStateReceiver } from '../shared/state-transport.mjs';
import { sourceVisible } from '../shared/source-visibility.mjs';

function AtlasMark({ small = false }: { small?: boolean }) { return <svg width={small ? 20 : 28} height={small ? 20 : 28} viewBox="0 0 32 32" fill="none" aria-hidden="true"><ellipse cx="16" cy="16" rx="13" ry="6.6" transform="rotate(-45 16 16)" stroke="currentColor" strokeWidth="1.5"/><ellipse cx="16" cy="16" rx="13" ry="6.6" transform="rotate(45 16 16)" stroke="currentColor" strokeWidth="1.5"/><circle cx="16" cy="16" r="2.2" fill="currentColor"/></svg>; }
function SourceIcon({ source }: { source: string }) { const Icon = ({ github: GitBranch, reddit: Reddit, x: Twitter, linkedin: Linkedin, stackexchange: Database } as Record<string, typeof GitBranch>)[source]; return source === 'hn' ? <span className="hn-icon" aria-label="Hacker News">Y</span> : Icon ? <Icon size={13}/> : <Globe2 size={13}/>; }
function IconButton({ children, label, onClick, active = false, disabled = false }: { children: React.ReactNode; label: string; onClick: () => void; active?: boolean; disabled?: boolean }) { return <button className={`icon-button ${active ? 'active' : ''}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>; }
const toolLabels: Record<string, string> = { atlas_overview: 'Surveying atlas', atlas_search: 'Searching evidence', atlas_signals: 'Finding problems', atlas_get_signal: 'Reading requests', atlas_get_source: 'Reading source', atlas_collect_requests: 'Collecting requests', atlas_save_idea: 'Saving idea', atlas_find_leads: 'Finding leads', atlas_research_lead: 'Checking profile', atlas_focus: 'Framing evidence', atlas_save_draft: 'Saving draft' };
Object.assign(toolLabels, { atlas_opportunities: 'Comparing customer workflows', atlas_get_opportunity: 'Reading requester cohort', atlas_recommend_opportunity: 'Framing demand', atlas_related_nodes: 'Following connections' });
const messageReferences = (message: Message | undefined, records: Source[], signals: Signal[] = []) => {
  const known = new Set(records.map(record => record.id));
  const problemId = message?.opportunity?.problemId;
  return [...new Set([...(message?.sourceIds || []).filter(id => known.has(id)), ...citedSourceIds(message?.text || '', records), ...(problemId && signals.some(signal => signal.id === problemId) ? [problemId] : [])])];
};

export function App() {
  const [state, setState] = useState<AtlasState | null>(null), [view, setView] = useState<View>('discover');
  const [selected, setSelected] = useState<string | null>(null), [topicId, setTopicId] = useState<string | null>(null);
  const [collectionMode, setCollectionMode] = useState<'requests' | 'topics' | 'saved'>('requests');
  const [requestWindow, setRequestWindow] = useState<'recent' | 'all'>('recent');
  const [citationOverride, setCitationOverride] = useState<string[] | null>(null);
  const [sourceFilters, setSourceFilters] = useState(['hn', 'github', 'reddit', 'stackexchange', 'x', 'linkedin']), [query, setQuery] = useState('');
  const [agentOpen, setAgentOpen] = useState(() => window.innerWidth > 760), [info, setInfo] = useState<AgentInfo>({ status: 'disconnected', error: null, models: [], busy: false });
  const [model, setModel] = useState(''), [input, setInput] = useState(''), [stream, setStream] = useState<Message | null>(null), [busy, setBusy] = useState(false);
  const [tool, setTool] = useState(''), [toast, setToast] = useState(''), [fatal, setFatal] = useState('');
  const [ideaOpen, setIdeaOpen] = useState(false), [ideaTitle, setIdeaTitle] = useState(''), [ideaDescription, setIdeaDescription] = useState('');
  const [ideaSourceIds, setIdeaSourceIds] = useState<string[]>([]);
  const [ideaProblemIds, setIdeaProblemIds] = useState<string[]>([]);
  const [focusRequest, setFocusRequest] = useState<{ ids: string[]; sequence: number } | null>(null);
  const [refreshProgress, setRefreshProgress] = useState('');
  const [saving, setSaving] = useState(false), [refreshing, setRefreshing] = useState(false), [ready, setReady] = useState(false);
  const [leadTab, setLeadTab] = useState<'evidence' | 'draft'>('evidence'), [draftChannel, setDraftChannel] = useState<'dm' | 'email'>('dm');
  const [researching, setResearching] = useState(false), [helpOpen, setHelpOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false), [health, setHealth] = useState<SourceHealth | null>(null), [healthError, setHealthError] = useState(''), [healthLoading, setHealthLoading] = useState(false);
  const [bookmarkPending, setBookmarkPending] = useState<string | null>(null);
  const [nodeSearch, setNodeSearch] = useState<{ key: string; data: NodeSearchResponse } | null>(null);
  const [relatedOpen, setRelatedOpen] = useState(false), [relatedLoading, setRelatedLoading] = useState(false), [relatedError, setRelatedError] = useState('');
  const [relatedNodes, setRelatedNodes] = useState<{ key: string; data: NodeSearchResponse } | null>(null);
  const graph = useRef<GraphHandle>(null), messageEnd = useRef<HTMLDivElement>(null), composer = useRef<HTMLTextAreaElement>(null);
  const fittedSearch = useRef('');
  const fittedRelated = useRef('');
  const stateRef = useRef(state); stateRef.current = state;
  const viewRef = useRef(view); viewRef.current = view;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stateReceiver = useRef(createStateReceiver<AtlasState>());
  const notify = useCallback((text: string) => { setToast(text); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 4000); }, []);
  const handleError = useCallback((error: unknown) => notify(error instanceof Error ? error.message : 'Request failed'), [notify]);
  const filterKey = [...sourceFilters].sort().join(',');
  const corpusKey = `${state?.corpus.fetchedAt || ''}:${state?.corpus.analysis?.generatedAt || ''}`;
  const searchKey = view === 'discover' && query.trim() ? JSON.stringify([query.trim(), topicId, filterKey, corpusKey]) : '';
  const relatedKey = selected ? JSON.stringify([selected, topicId, filterKey, corpusKey]) : '';
  useEffect(() => {
    if (!searchKey || !state) { fittedSearch.current = ''; return; }
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const params = new URLSearchParams({ q: query.trim(), sources: filterKey, limit: '24' });
    if (topicId) params.set('topic', topicId);
    const search = async () => {
      try {
        const response = await fetch(`/api/nodes/search?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Search unavailable');
        const data: NodeSearchResponse = await response.json();
        if (controller.signal.aborted) return;
        setNodeSearch({ key: searchKey, data });
        if (data.status === 'indexing') retry = setTimeout(search, 1000);
      } catch { /* Instant text matches remain available if semantic search is offline. */ }
    };
    const debounce = setTimeout(search, 280);
    return () => { controller.abort(); clearTimeout(debounce); clearTimeout(retry); };
  }, [searchKey]);
  useEffect(() => {
    if (!searchKey || nodeSearch?.key !== searchKey || nodeSearch.data.status !== 'ready' || !ready || fittedSearch.current === searchKey) return;
    if (selected) { fittedSearch.current = searchKey; return; }
    const frame = requestAnimationFrame(() => {
      const corpus = stateRef.current?.corpus;
      const records = new Map((corpus?.records || []).map(record => [record.id, record]));
      const signals = new Map((corpus?.signals || []).map(signal => [signal.id, signal]));
      const ids = [...new Set(nodeSearch.data.results.slice(0, 20).flatMap(result => result.kind === 'source' ? [result.id] : signals.get(result.id)?.sourceIds || result.sourceIds || []))].filter(id => { const record = records.get(id); return record && sourceFilters.includes(record.source) && (!topicId || record.topicId === topicId); }).slice(0, 160);
      if (ids.length) graph.current?.focus(ids);
      fittedSearch.current = searchKey;
    });
    return () => cancelAnimationFrame(frame);
  }, [nodeSearch, searchKey, ready, selected]);
  useEffect(() => {
    if (!selected) { setRelatedOpen(false); return; }
    if (!relatedOpen || !state || !state.corpus.records.some(record => record.id === selected) && !state.corpus.signals?.some(signal => signal.id === selected)) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    setRelatedLoading(true); setRelatedError('');
    const params = new URLSearchParams({ sources: filterKey, limit: '12' });
    if (topicId) params.set('topic', topicId);
    const load = async () => {
      try {
        const response = await fetch(`/api/nodes/${encodeURIComponent(selected)}/related?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Could not load related nodes.');
        const data: NodeSearchResponse = await response.json();
        if (controller.signal.aborted) return;
        setRelatedNodes({ key: relatedKey, data }); setRelatedLoading(false);
        if (data.status === 'indexing') retry = setTimeout(load, 1000);
      } catch (error) {
        if (!controller.signal.aborted) { setRelatedError(error instanceof Error ? error.message : 'Could not load related nodes.'); setRelatedLoading(false); }
      }
    };
    load();
    return () => { controller.abort(); clearTimeout(retry); };
  }, [relatedOpen, relatedKey]);
  useEffect(() => {
    if (!relatedOpen || !selected || !ready || relatedNodes?.key !== relatedKey || relatedNodes.data.status !== 'ready' || fittedRelated.current === relatedKey) return;
    fittedRelated.current = relatedKey;
    const frame = requestAnimationFrame(() => graph.current?.focus([selected, ...relatedNodes.data.results.slice(0, 8).map(result => result.id)]));
    return () => cancelAnimationFrame(frame);
  }, [relatedOpen, relatedNodes, relatedKey, selected, ready]);
  useEffect(() => {
    api<AtlasState>('state').then(s => { const initial = stateReceiver.current.initialize(s); setState(current => current || initial); setModel('gpt-6-luna'); }).catch(e => setFatal(e.message));
    api<AgentInfo>('agent/status').then(async i => {
      setBusy(i.busy);
      if (i.status === 'disconnected') {
        setInfo({ ...i, status: 'connecting' });
        try { setInfo(await api<AgentInfo>('agent/connect', {})); }
        catch (error) { setInfo({ ...i, status: 'error', error: error instanceof Error ? error.message : 'Codex connection failed' }); }
      } else setInfo(i);
    }).catch(handleError);
    const events = new EventSource('/api/events');
    const on = (event: string, callback: (data: any) => void) => events.addEventListener(event, (e: MessageEvent) => callback(JSON.parse(e.data)));
    on('state', patch => { const incoming = stateReceiver.current.receive(patch); if (incoming) setState(current => ({ ...current, ...incoming, corpus: patch.corpus || current?.corpus || incoming.corpus })); });
    on('agent-status', setInfo);
    on('agent-message', message => setState(s => s ? { ...s, messages: [...s.messages.filter(m => m.id !== message.id), message] } : s));
    on('agent-start', ({ id }) => { setBusy(true); setCitationOverride(null); setStream({ id, role: 'assistant', text: '' }); });
    on('agent-delta', ({ id, text }) => setStream({ id, role: 'assistant', text }));
    on('agent-reference', ({ nodeIds }) => graph.current?.pulse(nodeIds));
    on('agent-tool', ({ name, status }) => setTool(status === 'running' ? toolLabels[name] || 'Working' : ''));
    on('agent-done', message => {
      const ids = messageReferences(message, stateRef.current?.corpus.records || [], stateRef.current?.corpus.signals || []);
      setState(s => s ? { ...s, messages: [...s.messages.filter(m => m.id !== message.id), message] } : s);
      setStream(null); setBusy(false); setTool(''); setCitationOverride(ids);
      if (ids.length) { setTopicId(null); setQuery(''); if (message.opportunity) { setView('discover'); setSelected(null); } else if (viewRef.current === 'discover') setSelected(null); setFocusRequest({ ids, sequence: Date.now() }); }
    });
    on('focus', ({ nodeIds, view: nextView }) => { setView(nextView); setSelected(nodeIds[0] || null); setTopicId(null); setFocusRequest({ ids: nodeIds, sequence: Date.now() }); });
    on('draft', ({ leadId, channel }) => { setView('people'); setSelected(leadId); setLeadTab('draft'); setDraftChannel(channel); });
    on('refresh', ({ status, phase, completed, total, error }) => {
      setRefreshing(status === 'running');
      setRefreshProgress(status === 'running' ? `${phase === 'understanding' ? 'Understanding' : phase === 'reviewing' ? 'Reviewing' : 'Collecting'}${total ? ` ${completed || 0}/${total}` : ''}` : '');
      if (status === 'complete') notify('Atlas refreshed'); if (error) notify(error);
    });
    return () => { events.close(); clearTimeout(toastTimer.current); };
  }, [handleError, notify]);
  useEffect(() => { if (!focusRequest || !ready) return; const frame = requestAnimationFrame(() => graph.current?.focus(focusRequest.ids)); return () => cancelAnimationFrame(frame); }, [focusRequest, view, ready]);
  useEffect(() => { messageEnd.current?.scrollIntoView({ behavior: 'instant', block: 'end' }); }, [state?.messages.length, stream?.text, tool]);
  useEffect(() => {
    if (!healthOpen) return;
    let cancelled = false; setHealthLoading(true); setHealthError('');
    api<SourceHealth>('health').then(result => { if (!cancelled) setHealth(result); }).catch(error => { if (!cancelled) setHealthError(error.message); }).finally(() => { if (!cancelled) setHealthLoading(false); });
    return () => { cancelled = true; };
  }, [healthOpen, state?.corpus.fetchedAt, state?.corpus.analysis?.generatedAt]);
  useEffect(() => { const listener = (e: KeyboardEvent) => { if (e.key === 'Escape') { setIdeaOpen(false); setHelpOpen(false); setHealthOpen(false); setSelected(null); } if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setAgentOpen(true); composer.current?.focus(); } }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, []);
  const connect = async () => {
    setInfo(i => ({ ...i, status: 'connecting', error: null }));
    try { const result = await api<AgentInfo>('agent/connect', {}); setInfo(result); setModel('gpt-6-luna'); return result; }
    catch (e) { setInfo(i => ({ ...i, status: 'error', error: e instanceof Error ? e.message : 'Connection failed' })); throw e; }
  };
  const chat = async (text: string) => {
    if (!text.trim() || busy) return;
    setAgentOpen(true); setBusy(true); setInput('');
    try {
      if (info.status !== 'ready') await connect();
      await api('agent/chat', { text, model: model || undefined, context: { view, selectedId: selected, sourceIds: [...new Set([...(state?.pinned || []), ...(state?.corpus.records.some(s => s.id === selected) ? [selected] : [])])] } });
    } catch (error) { setBusy(false); handleError(error); }
  };
  const select = (id: string | null) => { setSelected(id); setRelatedOpen(false); setLeadTab('evidence'); };
  const openSource = (id: string) => { setSelected(id); setRelatedOpen(false); requestAnimationFrame(() => graph.current?.focus([id])); };
  const openIdea = () => { setIdeaTitle(state?.idea?.title || ''); setIdeaDescription(state?.idea?.description || ''); setIdeaProblemIds(state?.idea?.problemIds || []); setIdeaSourceIds([...new Set([...(state?.idea?.sourceIds || []), ...(state?.pinned || [])])]); setIdeaOpen(true); };
  const findPeople = async () => { setSaving(true); try { await api('leads', {}); setView('people'); setTopicId(null); setSelected(null); setQuery(''); } catch (e) { handleError(e); } finally { setSaving(false); } };
  const saveIdea = async (find: boolean) => {
    if (!state) return; setSaving(true);
    try { await api('idea', { title: ideaTitle, description: ideaDescription, sourceIds: ideaSourceIds, problemIds: ideaProblemIds, topicId }); await api('pins', { ids: ideaSourceIds }); setIdeaOpen(false); if (find) await findPeople(); else notify('Idea saved'); }
    catch (e) { handleError(e); } finally { setSaving(false); }
  };
  const pin = async (id: string) => { if (!state) return; try { await api('pins', { ids: state.pinned.includes(id) ? state.pinned.filter(p => p !== id) : [...state.pinned, id] }); } catch (e) { handleError(e); } };
  const saveProblem = async (problemId: string) => {
    if (!state || bookmarkPending) return;
    setBookmarkPending(problemId);
    try { const result = await api<{ shortlists: SavedProblem[] }>('shortlists', { problemId, saved: !(state.shortlists || []).some(entry => entry.problemId === problemId) }); setState(current => current ? { ...current, shortlists: result.shortlists } : current); }
    catch (error) { handleError(error); } finally { setBookmarkPending(null); }
  };
  if (!state) return <div className="boot"><AtlasMark/><span>{fatal || 'Opening atlas'}</span>{!fatal && <Loader2 size={16} className="spin"/>}</div>;
  const { corpus, idea, leads } = state;
  const topic = corpus.topics.find(t => t.id === topicId);
  const selectedTopic = corpus.topics.find(t => t.id === selected);
  const shortlists = state.shortlists || [];
  const selectedSaved = shortlists.find(entry => entry.problemId === selected);
  const selectedLiveSignal = corpus.signals?.find(s => s.id === selected);
  const selectedSignal = selectedLiveSignal || (selectedSaved ? savedSignal(selectedSaved, corpus.records) : undefined);
  const selectedIsSaved = shortlists.some(entry => entry.problemId === selectedSignal?.id);
  const source = corpus.records.find(s => s.id === selected);
  const lead = leads.find(l => l.id === selected);
  const authorSources = selected && !source && !selectedTopic && !lead && !selectedSignal ? corpus.records.filter(s => s.authorId === selected) : [];
  const searchTerms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const sourceMap = new Map(corpus.records.map(record => [record.id, record]));
  const recentCutoff = Date.now() - 365 * 86400000;
  const recentLeadIds = new Set(leads.filter(lead => lead.sourceIds.some(id => { const date = Date.parse(sourceMap.get(id)?.date || ''); return date >= recentCutoff && date <= Date.now(); })).map(lead => lead.id));
  const signalMap = new Map((corpus.signals || []).map(signal => [signal.id, signal]));
  const searchData = nodeSearch?.key === searchKey ? nodeSearch.data : null;
  const recordAllowed = (record: Source) => sourceVisible(record) && (!topicId || record.topicId === topicId) && sourceFilters.includes(record.source);
  const semanticIds = new Set<string>(), semanticScores = new Map<string, number>();
  for (const result of searchData?.results || []) {
    const ids = result.kind === 'problem' ? signalMap.get(result.id)?.sourceIds || result.sourceIds || [] : [result.id];
    const allowed = ids.filter(id => { const record = sourceMap.get(id); return record && recordAllowed(record); });
    if (!allowed.length) continue;
    semanticIds.add(result.id); semanticScores.set(result.id, result.score);
    for (const id of allowed) { semanticIds.add(id); semanticScores.set(id, Math.max(semanticScores.get(id) || 0, result.score)); }
  }
  const filteredRecords = corpus.records.filter(record => recordAllowed(record) && (semanticIds.has(record.id) || searchTerms.every(term => `${record.title} ${record.text} ${record.author}`.toLowerCase().includes(term)))).sort((a, b) => query.trim() ? (semanticScores.get(b.id) || 0) - (semanticScores.get(a.id) || 0) : 0);
  const availablePlatforms = [...new Set(corpus.records.map(r => r.source))];
  const filteredIds = new Set(filteredRecords.map(r => r.id));
  const scoreForSignal = (signal: Signal) => Math.max(semanticScores.get(signal.id) || 0, ...signal.sourceIds.map(id => semanticScores.get(id) || 0));
  const visibleSignals = (corpus.signals || []).filter(signal => {
    const eligible = signal.sourceIds.some(id => { const record = sourceMap.get(id); return record && (!topicId || record.topicId === topicId) && sourceFilters.includes(record.source); });
    const meaning = `${signal.label} ${signal.workflow || ''} ${signal.problem || ''} ${signal.desiredOutcome || ''}`.toLowerCase();
    return (requestWindow === 'recent' ? signal.requesterCount : signal.allTimeCount) > 0 && eligible && (semanticIds.has(signal.id) || signal.sourceIds.some(id => filteredIds.has(id)) || searchTerms.every(term => meaning.includes(term)));
  }).sort((a, b) => (query.trim() ? scoreForSignal(b) - scoreForSignal(a) : 0) || (requestWindow === 'all' ? b.allTimeCount - a.allTimeCount || b.requesterCount - a.requesterCount : b.requesterCount - a.requesterCount)).slice(0, 24);
  const searchNodeIds = query.trim() ? [...filteredIds, ...visibleSignals.map(signal => signal.id)] : null;
  const relatedData = relatedNodes?.key === relatedKey ? relatedNodes.data : null;
  const relatedResults = (relatedData?.results || []).filter(result => {
    if (result.id === selected) return false;
    const record = sourceMap.get(result.id);
    if (record) return recordAllowed(record);
    return signalMap.get(result.id)?.sourceIds.some(id => { const record = sourceMap.get(id); return record && recordAllowed(record); });
  }).slice(0, 8);
  const openRelated = (id: string) => { setView('discover'); setSelected(id); setLeadTab('evidence'); setFocusRequest({ ids: [id], sequence: Date.now() }); };
  const related = <div className="related-section">
    <button className={`related-toggle ${relatedOpen ? 'current' : ''}`} aria-expanded={relatedOpen} onClick={() => setRelatedOpen(open => !open)}><GitBranch size={12}/>Related{relatedLoading && relatedOpen ? <Loader2 size={11} className="spin"/> : <ChevronDown size={11}/>}</button>
    {relatedOpen && <div className="related-list" aria-label="Related nodes">
      {relatedData?.status === 'indexing' && <span className="related-status" role="status">Indexing</span>}
      {relatedError ? <span className="related-status" role="status">{relatedError}</span> : relatedResults.map(result => { const record = sourceMap.get(result.id), signal = signalMap.get(result.id); return <button key={result.id} onClick={() => openRelated(result.id)}>{record ? <SourceIcon source={record.source}/> : <Layers2 size={12}/>}<span>{record?.title || signal?.label}</span><ChevronRight size={11}/></button>; })}
      {!relatedLoading && !relatedError && relatedData?.status !== 'indexing' && !relatedResults.length && <span className="related-status">No related nodes.</span>}
    </div>}
  </div>;
  const uniqueAuthors = new Set(filteredRecords.map(r => r.authorId)).size;
  const savedProblems = shortlists.map(entry => ({ entry, isLive: Boolean(corpus.signals?.some(signal => signal.id === entry.problemId)), signal: corpus.signals?.find(signal => signal.id === entry.problemId) || savedSignal(entry, corpus.records) })).filter(({ signal }) => semanticIds.has(signal.id) || signal.sourceIds.some(id => filteredIds.has(id)) && Boolean(query.trim()) || searchTerms.every(term => `${signal.label} ${signal.workflow || ''} ${signal.problem || ''}`.toLowerCase().includes(term)));
  const inspectProblem = (signal: Signal) => { setView('discover'); setSelected(signal.id); setRelatedOpen(false); setLeadTab('evidence'); setFocusRequest({ ids: signal.sourceIds.filter(id => { const record = sourceMap.get(id); return record && recordAllowed(record); }), sequence: Date.now() }); };
  const useProblem = (signal: Signal) => { setIdeaTitle(signal.label); setIdeaDescription([signal.audience, signal.problem, signal.desiredOutcome].filter(Boolean).join('. ')); setIdeaProblemIds([signal.id]); setIdeaSourceIds(signal.sourceIds.slice(0, 30)); setIdeaOpen(true); };
  const visibleMessages = [...state.messages, ...(stream ? [stream] : [])];
  const latestAnswer = stream || [...state.messages].reverse().find(m => m.role === 'assistant');
  const referencedIds = busy ? [] : citationOverride || messageReferences(latestAnswer, corpus.records, corpus.signals);
  const profile = lead ? state.profiles[lead.id] : null;
  const research = async () => { if (!lead) return; setResearching(true); try { await api('leads/research', { leadId: lead.id }); } catch (e) { handleError(e); } finally { setResearching(false); } };

  return <div className={`app ${agentOpen ? 'agent-open' : 'agent-closed'}`}>
    <aside className="sidebar">
      <a href="/" className="brand" aria-label="Internet Atlas home"><AtlasMark/><span>internet atlas<span className="brand-period">.</span></span></a>
      <div className="workspace-label"><span className="status-dot"/> Public data</div>
      <nav className="main-nav" aria-label="Graphs">
        <button className={view === 'discover' ? 'selected' : ''} onClick={() => { setView('discover'); setSelected(null); setQuery(''); }}><Globe2 size={16}/> Discover <span>{corpus.records.length}</span></button>
        <button className={view === 'people' ? 'selected' : ''} onClick={() => { setView('people'); setSelected(null); setTopicId(null); setQuery(''); }}><Users size={16}/> Leads {leads.length > 0 && <span>{leads.length}</span>}</button>
      </nav>
      <div className="mobile-utilities"><IconButton label="Saved problems" active={collectionMode === 'saved' && view === 'discover'} onClick={() => { setView('discover'); setCollectionMode('saved'); setSelected(null); setQuery(''); }}><Bookmark size={16}/></IconButton><IconButton label="Source health" onClick={() => setHealthOpen(true)}><Activity size={16}/></IconButton></div>
      {view === 'discover' ? <>
        <div className="collection-tabs" role="tablist" aria-label="Explore problems"><button role="tab" aria-selected={collectionMode === 'requests'} className={collectionMode === 'requests' ? 'current' : ''} onClick={() => setCollectionMode('requests')}>Requests</button><button role="tab" aria-selected={collectionMode === 'topics'} className={collectionMode === 'topics' ? 'current' : ''} onClick={() => setCollectionMode('topics')}>Topics</button><button role="tab" aria-selected={collectionMode === 'saved'} className={collectionMode === 'saved' ? 'current saved-tab' : 'saved-tab'} onClick={() => { setCollectionMode('saved'); setTopicId(null); setQuery(''); }}><Bookmark size={11}/>Saved{shortlists.length > 0 && <small>{shortlists.length}</small>}</button></div>
        {collectionMode === 'requests' && <div className="collection-scope"><button title="Request count window" onClick={() => setRequestWindow(value => value === 'recent' ? 'all' : 'recent')}>{requestWindow === 'recent' ? 'Past 365 days' : 'All time'}<ChevronDown size={10}/></button><IconButton label="Show all topics" onClick={() => { setTopicId(null); setSelected(null); graph.current?.fit(); }}><Layers2 size={12}/></IconButton></div>}
        {collectionMode === 'requests' ? <div className="request-list">{visibleSignals.map(signal => <button key={signal.id} className={selected === signal.id ? 'current' : ''} onClick={() => inspectProblem(signal)} title={`${signal.requesterCount} distinct accounts in 365 days, ${signal.allTimeCount} all time`}><span>{signal.label}</span><small className={`request-count ${signal.tier.id}`}>{requestWindow === 'recent' ? signal.requesterCount : signal.allTimeCount}</small></button>)}{!visibleSignals.length && <p className="empty-copy">No matching problems.</p>}</div> : collectionMode === 'saved' ? <div className="saved-list">{savedProblems.map(({ entry, signal, isLive }) => <div key={entry.problemId} className={selected === entry.problemId ? 'current' : ''}><button className="saved-problem" onClick={() => inspectProblem(signal)}><span>{signal.label}</span><small>{signal.requesterCount} {isLive ? 'recent' : 'at save'}<span>·</span>{signal.allTimeCount} all time</small></button><IconButton label={`Remove saved problem: ${signal.label}`} active disabled={Boolean(bookmarkPending)} onClick={() => saveProblem(entry.problemId)}><Bookmark size={12}/></IconButton></div>)}{!savedProblems.length && <div className="saved-empty"><Bookmark size={19}/><p>{shortlists.length ? 'No matching saved problems.' : 'Save problems worth exploring.'}</p></div>}</div> : <div className="topic-list">{corpus.topics.map(t => <button key={t.id} className={topicId === t.id ? 'current' : ''} onClick={() => { const next = topicId === t.id ? null : t.id; setTopicId(next); setSelected(next); if (next) setTimeout(() => graph.current?.fit(), 100); else graph.current?.fit(); }}><i style={{ background: t.color }}/><span>{t.name}</span><small>{corpus.records.filter(r => r.topicId === t.id).length}</small></button>)}</div>}
        <div className="section-label sources-label">Sources</div>
        <div className="source-filters">{availablePlatforms.map(s => <button key={s} className={sourceFilters.includes(s) ? 'enabled' : ''} onClick={() => setSourceFilters(old => old.includes(s) ? old.filter(x => x !== s) : [...old, s])}><SourceIcon source={s}/><span>{sourceName(s)}</span><span className="checkbox">{sourceFilters.includes(s) && <Check size={10}/>}</span></button>)}</div>
        {state.pinned.length > 0 && <button className="pinned-row" onClick={openIdea}><Pin size={13}/>{state.pinned.length} pinned<ChevronRight size={13}/></button>}
      </> : <>
        <div className="section-label">Leads<span>{leads.length}</span></div>
        <div className="people-list">{leads.filter(l => l.name.toLowerCase().includes(query.toLowerCase())).map(l => <button key={l.id} aria-label={l.name} className={selected === l.id ? 'current' : ''} onClick={() => { select(l.id); requestAnimationFrame(() => graph.current?.focus([l.id])); }}><span className="person-avatar" style={{ color: corpus.topics.find(t => t.id === l.topicId)?.color }}>{l.name.slice(0, 1).toUpperCase()}</span><span>{l.name}<small>{l.kind === 'Requester' && !recentLeadIds.has(l.id) ? 'Historical requester' : l.kind || sourceName(l.source)}</small></span>{state.drafts[`${l.id}:dm`] || state.drafts[`${l.id}:email`] ? <span className="tiny-dot"/> : null}</button>)}</div>
        {idea && !leads.length && <button className="secondary sidebar-action" onClick={findPeople}>Find leads<ArrowRight size={14}/></button>}
      </>}
      <div className="sidebar-bottom"><button onClick={() => setHealthOpen(true)}><Activity size={14}/> Source health</button><button onClick={() => setHelpOpen(true)}><CircleHelp size={14}/> About this atlas</button><div className="refresh-row"><span role="status">{refreshProgress || niceDate(corpus.fetchedAt)}</span><IconButton label="Refresh public sources" disabled={refreshing} onClick={() => api('refresh', {}).catch(handleError)}><RefreshCw size={13} className={refreshing ? 'spin' : ''}/></IconButton></div></div>
    </aside>

    <main className="workspace">
      <header className="graph-header"><div className="breadcrumbs"><Globe2 size={14}/><span>{view === 'discover' ? 'Atlas' : 'Leads'}</span>{topic && <><ChevronRight size={13}/><span style={{ color: topic.color }}>{topic.name}</span></>}</div><div className="header-right">{searchData?.status === 'indexing' && <span className="search-status" role="status" title={`${searchData.indexed} of ${searchData.total} indexed`}><Loader2 size={10} className="spin"/>Indexing</span>}<div className="search-field"><Search size={14}/><input aria-label="Search atlas" placeholder={view === 'discover' ? 'Search by meaning' : 'Find a person'} value={query} onChange={e => { setQuery(e.target.value); setSelected(null); setRelatedOpen(false); }}/>{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={12}/></button>}</div>{!agentOpen && <IconButton label="Open agent" onClick={() => setAgentOpen(true)}><MessageCircle size={17}/></IconButton>}</div></header>
      <div className="graph-area">
        <AtlasGraph ref={graph} state={state} view={view} topicId={topicId} sourceFilters={sourceFilters} selected={selected} query={query} searchNodeIds={searchNodeIds} relatedIds={relatedOpen ? relatedResults.map(result => result.id) : []} referencedIds={referencedIds} onSelect={select} onReady={() => setReady(true)}/>
        {view === 'discover' && collectionMode === 'saved' && !selected && <section className="mobile-saved inspector" aria-label="Saved problems"><div className="inspector-top"><span className="eyebrow">Saved problems</span><IconButton label="Close saved problems" onClick={() => setCollectionMode('requests')}><X size={14}/></IconButton></div><div className="saved-list">{savedProblems.map(({ entry, signal, isLive }) => <div key={entry.problemId}><button className="saved-problem" onClick={() => inspectProblem(signal)}><span>{signal.label}</span><small>{signal.requesterCount} {isLive ? 'recent' : 'at save'}<span>·</span>{signal.allTimeCount} all time</small></button><IconButton label={`Remove saved problem: ${signal.label}`} active disabled={Boolean(bookmarkPending)} onClick={() => saveProblem(entry.problemId)}><Bookmark size={12}/></IconButton></div>)}{!savedProblems.length && <div className="saved-empty"><Bookmark size={19}/><p>Save problems worth exploring.</p></div>}</div></section>}
        {!ready && <div className="graph-loading"><Loader2 className="spin" size={15}/>Arranging atlas</div>}
        <div className="canvas-caption"><span className="live-dot"/>{view === 'discover' ? <>{filteredRecords.length} sources<span className="caption-separator">·</span>{uniqueAuthors} public authors</> : <>{leads.length}{state.leadSearch && state.leadSearch.totalMatches > leads.length ? ` of ${state.leadSearch.totalMatches}` : ''} leads{recentLeadIds.size < leads.length && <><span className="caption-separator">·</span>{recentLeadIds.size} recent</>}{state.leadSearch && <><span className="caption-separator">·</span>{state.leadSearch.method === 'selected-problem' ? 'requested this problem' : state.leadSearch.method === 'semantic-problem' ? 'matched problems' : 'keyword match'}</>}</>}</div>
        {referencedIds.length > 0 && <button className="citation-focus" onClick={() => graph.current?.focus(referencedIds)} title="Fit evidence"><i/>{referencedIds.filter(id => sourceMap.has(id)).length} sources</button>}<div className="graph-controls"><IconButton label="Zoom in" onClick={() => graph.current?.zoom(1)}><Plus size={16}/></IconButton><IconButton label="Zoom out" onClick={() => graph.current?.zoom(-1)}><Minus size={16}/></IconButton><div/><IconButton label="Fit graph" onClick={() => graph.current?.fit()}><Maximize2 size={15}/></IconButton></div>
        <div className="graph-legend"><span><i className="legend-source"/>Source</span><span><i className="legend-person"/>Author</span><span title="Dashed links indicate inferred similarity or relevance"><i className="legend-line"/>Inferred</span></div>

        {view === 'discover' && !selectedSignal && (query || selectedTopic || source || authorSources.length > 0) && <section className={`inspector ${source ? 'source-inspector' : ''}`} key={source?.id || selectedTopic?.id || 'results'} aria-label="Evidence inspector">
          <div className="inspector-top"><span className="eyebrow">{source ? sourceName(source.source) : selectedTopic ? 'Collection' : query ? 'Search' : 'Public author'}</span><IconButton label="Close inspector" onClick={() => { setSelected(null); setQuery(''); }}><X size={14}/></IconButton></div>
          {source ? <>
            <h2>{source.title}</h2><div className="source-meta"><a href={source.profileUrl} target="_blank" rel="noreferrer">{source.author}</a><span>·</span>{niceDate(source.date)}{source.status === 'closed' && <span className="closed-tag">Closed</span>}</div>
            <div className="source-text">{source.text}</div><Provenance source={source}/>
            <div className="inspector-actions"><a className="text-link" href={source.url} target="_blank" rel="noreferrer">Original<ExternalLink size={12}/></a><button className={state.pinned.includes(source.id) ? 'secondary is-pinned' : 'secondary'} onClick={() => pin(source.id)}><Pin size={13}/>{state.pinned.includes(source.id) ? 'Pinned' : 'Pin evidence'}</button></div>
            {related}
          </> : <>
            <h2>{selectedTopic?.name || (authorSources.length ? authorSources[0].author : 'Results')}</h2>
            <div className="evidence-list">{(query.trim() && !authorSources.length && !selectedTopic ? filteredRecords.slice(0, 100) : interleaveSources(authorSources.length ? authorSources : filteredRecords.filter(s => !selectedTopic || s.topicId === selectedTopic.id))).map(s => <button key={s.id} onClick={() => openSource(s.id)}><div><SourceIcon source={s.source}/><span>{s.author}</span><small>{niceDate(s.date)}</small></div><strong>{s.title}</strong><p>{s.text.slice(0, 160)}{s.text.length > 160 ? '…' : ''}</p></button>)}{!filteredRecords.length && <p className="empty-copy">No matching sources.</p>}</div>
          </>}
        </section>}

        {view === 'discover' && selectedSignal && <section className="inspector signal-inspector" aria-label="Request inspector">
          <div className="inspector-top"><span className="eyebrow">{selectedSaved && !selectedLiveSignal ? 'Saved problem' : 'Request group'}</span><div className="inspector-tools"><IconButton label={selectedIsSaved ? 'Remove saved problem' : 'Save problem'} active={selectedIsSaved} disabled={Boolean(bookmarkPending)} onClick={() => saveProblem(selectedSignal.id)}>{bookmarkPending === selectedSignal.id ? <Loader2 size={13} className="spin"/> : <Bookmark size={13}/>}</IconButton><IconButton label="Close request" onClick={() => setSelected(null)}><X size={14}/></IconButton></div></div>
          <h2>{selectedSignal.label}</h2>
          <div className="signal-summary"><strong>{selectedSignal.requesterCount}</strong><span>requesters <small>{selectedSaved && !selectedLiveSignal ? 'at save' : 'past 365 days'}</small></span><span className={`tier-label ${selectedSignal.tier.id}`}>{selectedSignal.tier.label}</span></div>
          <div className="signal-thresholds" title="Distinct public accounts. Group membership is inferred.">{[10, 20, 50].map((n, i) => <span key={n} className={selectedSignal.requesterCount >= n ? 'reached' : ''}><i/>{n}+ {['Recurring', 'Growing', 'Strong'][i]}</span>)}</div>
          <div className="signal-provenance">{selectedSignal.platforms.map(sourceName).join(' · ')}{selectedSignal.allTimeCount > selectedSignal.requesterCount && <span>{selectedSignal.allTimeCount} all time</span>}{selectedSignal.archiveCount > 0 && <span>{selectedSignal.archiveCount} from datasets</span>}{selectedSaved && !selectedLiveSignal && <span>Snapshot {niceDate(selectedSaved.asOf)}</span>}</div>
          <div className="evidence-list request-evidence">{selectedSignal.sourceIds.map(id => corpus.records.find(r => r.id === id)).filter((r): r is Source => Boolean(r)).map(record => <button key={record.id} onClick={() => openSource(record.id)}><div><SourceIcon source={record.source}/><span>{record.author}</span><small>{niceDate(record.date)}</small></div><p>{record.request?.quote || record.text.slice(0, 450)}</p></button>)}</div>
          <div className="inspector-actions"><button className="text-link" onClick={() => useProblem(selectedSignal)}>Use in idea<ArrowRight size={12}/></button><button className="secondary" disabled={busy} onClick={() => chat('Investigate this request group. Check whether the requests describe one specific need, then suggest a concrete product.')}>Explore with Atlas<ArrowUp size={12}/></button></div>
          {selectedLiveSignal && related}
        </section>}

        {view === 'people' && lead && <section className="inspector lead-inspector" aria-label="Person inspector">
          <div className="inspector-top"><span className="eyebrow">{lead.kind || 'Person'}</span><IconButton label="Close person" onClick={() => setSelected(null)}><X size={14}/></IconButton></div>
          <div className="lead-heading"><span className="person-avatar large" style={{ color: corpus.topics.find(t => t.id === lead.topicId)?.color }}>{lead.name.slice(0, 1).toUpperCase()}</span><div><h2>{profile?.displayName || lead.name}</h2><a className="text-link muted" href={lead.profileUrl} target="_blank" rel="noreferrer">{sourceName(lead.source)}<ExternalLink size={11}/></a></div></div>
          <div className="inspector-tabs"><button className={leadTab === 'evidence' ? 'current' : ''} onClick={() => setLeadTab('evidence')}>Evidence</button><button className={leadTab === 'draft' ? 'current' : ''} onClick={() => setLeadTab('draft')}>Draft</button></div>
          {leadTab === 'evidence' ? <div className="lead-evidence-body">
            {profile?.bio && <p className="profile-bio">{profile.bio.slice(0, 350)}</p>}
            {profile?.company && <div className="profile-company">{profile.company}<small>self-reported</small></div>}
            <div className="evidence-list compact">{lead.sourceIds.map(id => { const s = corpus.records.find(s => s.id === id)!; return <a key={id} href={s.url} target="_blank" rel="noreferrer"><div><SourceIcon source={s.source}/><span>{niceDate(s.date)}</span><small>{s.status === 'open' ? 'Open issue' : s.status}</small><ExternalLink size={11}/></div><strong>{s.title}</strong><p>{s.request?.quote || s.text.slice(0, 260)}</p></a>; })}</div>
            {profile && <div className="verification-note">{profile.status === 'ok' ? `Checked ${niceDate(profile.fetchedAt)}` : profile.status === 'link-only' ? 'Public link only. Profile not verified.' : 'Profile check failed'}{profile.sourceChecks.some(s => ['closed', 'deleted'].includes(s.status)) && <strong>Some evidence is closed or deleted.</strong>}</div>}
            <div className="inspector-actions"><button className="text-link" disabled={researching} onClick={research}>{researching ? <Loader2 size={12} className="spin"/> : <RefreshCw size={12}/>}Check profile</button><button className="primary small" onClick={() => { setLeadTab('draft'); chat(`Draft a brief DM for ${lead.name}.`); }}>Draft message<ArrowRight size={13}/></button></div>
          </div> : <DraftEditor key={`${lead.id}:${draftChannel}`} lead={lead} state={state} channel={draftChannel} setChannel={setDraftChannel} onError={handleError} notify={notify} onAgent={() => chat(`Draft a brief ${draftChannel === 'dm' ? 'DM' : 'email'} for ${lead.name}.`)}/>}
        </section>}
        {view === 'people' && source && <section className="inspector source-inspector"><div className="inspector-top"><span className="eyebrow">{sourceName(source.source)}</span><IconButton label="Close source" onClick={() => setSelected(null)}><X size={14}/></IconButton></div><h2>{source.title}</h2><div className="source-meta">{source.author} · {niceDate(source.date)}</div><div className="source-text">{source.text}</div><Provenance source={source}/><a className="text-link" href={source.url} target="_blank" rel="noreferrer">Original<ExternalLink size={12}/></a></section>}
        {view === 'people' && !idea && <div className="canvas-empty"><Users size={26}/><h2>Turn a problem into conversations.</h2><button className="primary" onClick={openIdea}>Create idea<ArrowRight size={14}/></button></div>}
        {view === 'people' && idea && !leads.length && <div className="canvas-empty"><Users size={26}/><h2>Find people who asked for this.</h2><button className="primary" onClick={findPeople} disabled={saving}>Find leads<ArrowRight size={14}/></button></div>}
      </div>
      <footer className="idea-bar"><button className="idea-summary" onClick={openIdea}><span className="idea-glyph">✧</span><span>{idea ? <><small>Your idea</small><strong>{idea.title}</strong></> : <><strong>What will you build?</strong>{state.pinned.length > 0 && <small>{state.pinned.length} sources pinned</small>}</>}</span><ChevronDown size={13}/></button><div className="idea-bar-actions">{idea && <a className="icon-button" title="Export idea, leads and drafts" aria-label="Export research" href="/api/export" download><Download size={15}/></a>}<button className="primary" disabled={saving} onClick={idea ? findPeople : openIdea}>{saving ? <Loader2 size={14} className="spin"/> : idea ? 'Find leads' : 'Create idea'}{!saving && <ArrowRight size={14}/>}</button></div></footer>
    </main>

    {agentOpen && <aside className="agent-panel" aria-label="Atlas agent">
      <header className="agent-header"><div><AtlasMark small/><span>Atlas</span><span className={`agent-status-dot ${info.status === 'ready' ? 'connected' : ''}`} title={info.status === 'ready' ? 'Codex connected' : 'Codex not connected'}/></div><IconButton label="Minimize agent" onClick={() => setAgentOpen(false)}><PanelRightClose size={16}/></IconButton></header>
      <div className={`agent-messages ${!visibleMessages.length ? 'is-empty' : ''}`}>
        {!visibleMessages.length && <div className="agent-welcome"><div className="welcome-mark"><AtlasMark/></div><h1>Find your next thing.</h1><div className="agent-suggestions"><button onClick={() => chat('What business would you build from this data? Show measurable demand and a path to the first customers.')}><span>Find an opportunity</span><ArrowRight size={14}/></button><button onClick={() => { setInput('I want to explore '); composer.current?.focus(); }}><span>Explore a problem</span><ArrowRight size={14}/></button></div></div>}
        {visibleMessages.map(m => <div key={m.id} className={`chat-message ${m.role}`}><div className="message-content">{m.role === 'assistant' ? <ReactMarkdown components={{ a: props => <a {...props} target="_blank" rel="noreferrer" onClick={event => { const source = corpus.records.find(r => canonicalSourceUrl(r.url) === canonicalSourceUrl(props.href || '')); if (!source || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); setCitationOverride(messageReferences(m, corpus.records, corpus.signals)); setView('discover'); setTopicId(null); setQuery(''); setSelected(source.id); setTimeout(() => graph.current?.focus([source.id]), 80); }}/> }}>{m.text}</ReactMarkdown> : m.text}{m.opportunity && !m.error && <button className="recommendation-action" onClick={() => { const opportunity = m.opportunity!; setIdeaTitle(opportunity.title); setIdeaDescription(opportunity.description); setIdeaProblemIds([opportunity.problemId]); setIdeaSourceIds(opportunity.sourceIds.filter(id => sourceMap.has(id)).slice(0, 30)); setIdeaOpen(true); }}>Use this idea<ArrowRight size={12}/></button>}{m.error && <p className="message-error">{m.error}</p>}</div></div>)}
        {busy && <div className="agent-working"><Loader2 size={12} className="spin"/><span>{tool || (stream?.text ? 'Working' : 'Thinking')}</span></div>}
        <div ref={messageEnd}/>
      </div>
      <div className="agent-bottom">
        {selected && <div className="context-chip"><Focus size={11}/><span>{source?.title || selectedSignal?.label || lead?.name || selectedTopic?.name || selected}</span><button aria-label="Clear selected context" onClick={() => setSelected(null)}><X size={11}/></button></div>}
        {info.error && <div className="connection-error">{info.error}<button onClick={() => connect().catch(handleError)}>Retry</button></div>}
        <form className="composer" onSubmit={e => { e.preventDefault(); chat(input); }}><textarea ref={composer} aria-label="Message Atlas" placeholder="Ask Atlas…" rows={2} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chat(input); } }}/><div className="composer-bottom"><div className="model-picker">{info.status === 'ready' && info.models.length ? <span className="model-name">GPT 6 Luna</span> : <button type="button" disabled={info.status === 'connecting'} onClick={() => connect().catch(handleError)}>{info.status === 'connecting' ? 'Connecting…' : 'Connect Codex'}<ChevronDown size={11}/></button>}</div>{busy ? <button className="send-button stop-button" type="button" title="Stop agent" aria-label="Stop agent" onClick={() => api('agent/stop', {}).catch(handleError)}><Square size={12} fill="currentColor"/></button> : <button type="submit" className="send-button" disabled={!input.trim()} aria-label="Send message"><ArrowUp size={16}/></button>}</div></form>
        <div className="agent-footnote"><span>Codex<span className="caption-separator">·</span>Local workspace</span><kbd>⌘ K</kbd></div>
      </div>
    </aside>}

    {ideaOpen && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setIdeaOpen(false); }}><section className="idea-modal" role="dialog" aria-modal="true" aria-labelledby="idea-dialog-title"><div className="modal-header"><h2 id="idea-dialog-title">Your idea</h2><IconButton label="Close idea editor" onClick={() => setIdeaOpen(false)}><X size={16}/></IconButton></div><label>Name<input autoFocus placeholder="A specific problem, a better way" maxLength={160} value={ideaTitle} onChange={e => setIdeaTitle(e.target.value)}/></label><label>Who is it for? What does it do?<textarea placeholder="For [person] who needs to [workflow]…" rows={4} value={ideaDescription} onChange={e => setIdeaDescription(e.target.value)} maxLength={3000}/></label>{ideaProblemIds.length > 0 && <div className="attached-problems">{ideaProblemIds.map(id => { const problem = corpus.signals?.find(signal => signal.id === id); return problem && <div key={id}><span>{problem.label}<small>{problem.requesterCount} requesters</small></span><button aria-label={`Detach problem: ${problem.label}`} onClick={() => { setIdeaProblemIds(ids => ids.filter(value => value !== id)); setIdeaSourceIds(ids => ids.filter(value => !problem.sourceIds.includes(value))); }}><X size={12}/></button></div>; })}</div>}{ideaSourceIds.length > 0 && <div className="attached-sources"><span className="eyebrow">Evidence</span>{ideaSourceIds.map(id => { const s = corpus.records.find(r => r.id === id); return s && <div key={id}><SourceIcon source={s.source}/><span>{s.title}</span><button aria-label={`Remove evidence: ${s.title}`} onClick={() => setIdeaSourceIds(ids => ids.filter(i => i !== id))}><X size={11}/></button></div>; })}</div>}<div className="modal-actions"><button className="secondary" disabled={saving || !ideaTitle.trim()} onClick={() => saveIdea(false)}>Save idea</button><button className="primary" disabled={saving || !ideaTitle.trim()} onClick={() => saveIdea(true)}>{saving ? <Loader2 size={14} className="spin"/> : <>Find leads<ArrowRight size={14}/></>}</button></div></section></div>}
    {healthOpen && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setHealthOpen(false); }}><SourceHealthDialog health={health} loading={healthLoading} error={healthError} refreshing={refreshing} feeds={corpus.feeds || []} onClose={() => setHealthOpen(false)} onRefresh={() => api('refresh', {}).catch(handleError)} onCopy={async () => { try { await navigator.clipboard.writeText(JSON.stringify(health, null, 2)); notify('Diagnostics copied'); } catch (error) { handleError(error); } }}/></div>}
    {helpOpen && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setHelpOpen(false); }}><section className="help-modal" role="dialog" aria-modal="true" aria-label="About this atlas"><div className="modal-header"><h2>About this atlas</h2><IconButton label="Close about" onClick={() => setHelpOpen(false)}><X size={16}/></IconButton></div><p>{corpus.records.length} public records from {availablePlatforms.map(sourceName).join(', ')}. Fetched {niceDate(corpus.fetchedAt)}.</p><p>Solid links show authorship and topics. Dashed links show inferred request groups or idea relevance. Nodes pulse as Atlas reads and cites them. Final citations stay outlined in white and are framed together.</p><p>{corpus.analysis?.analyzedCount || 0} of {corpus.analysis?.candidateCount || 0} candidate posts analyzed. Only quote-validated requests enter reviewed problem groups.</p><p>Request tiers count distinct public accounts over 365 days: 10+ recurring, 20+ growing, 50+ strong. Votes, endorsements and repeated posts do not count. Grouping is inferred. Cross-platform identities may overlap.</p><p>People are candidates for a conversation. Affiliation is self-reported. Contact details appear only when public. Outreach stays in drafts.</p><p>Reddit includes public feeds and archives. X comes from an opt-in public archive. LinkedIn is not connected. Archive posts keep their original dates.</p><button className="secondary about-health" onClick={() => { setHelpOpen(false); setHealthOpen(true); }}><Activity size={13}/>Source health<ArrowRight size={13}/></button><p className="credits">Graph inspired by <a href="https://github.com/Graphify-Labs/graphify" target="_blank" rel="noreferrer">Graphify</a>. Your idea, conversation, saved problems and drafts are saved on this computer. Selected evidence is sent to GPT 6 Luna.</p></section></div>}
    {toast && <div role="status" className="toast">{toast}</div>}
  </div>;
}

function savedSignal(saved: SavedProblem, records: Source[]): Signal {
  const sources = records.filter(record => saved.sourceIds.includes(record.id));
  const count = saved.requesterCount;
  const tier = count >= 50 ? { id: 'strong', label: 'Strong', rank: 3, nextAt: null } : count >= 20 ? { id: 'growing', label: 'Growing', rank: 2, nextAt: 50 } : count >= 10 ? { id: 'recurring', label: 'Recurring', rank: 1, nextAt: 20 } : { id: 'early', label: 'Early', rank: 0, nextAt: 10 };
  return { ...saved, id: saved.problemId, topicId: sources[0]?.topicId || 'software', representativeId: saved.sourceIds[0], platforms: [...new Set(sources.map(source => source.source))], archiveCount: 0, paymentMentions: 0, threadCount: 0, windowDays: 365, tier, reviewed: true };
}

function healthLabel(source: SourceHealth['sources'][number]) {
  const detail = `${source.access || ''} ${source.message || ''}`;
  if (/rate.?limit|HTTP\s*429/i.test(detail)) return 'Rate limited';
  if (/denied|HTTP\s*403|forbidden/i.test(detail)) return 'Access denied';
  if (source.status === 'not-connected') return 'Not connected';
  if (!source.lastAttemptAt && !source.feedsOk && !source.feedsFailed) {
    if (source.datasetCount) return 'Imported';
    if (source.lastFetchedAt) return 'Cached';
    return 'Not called';
  }
  if (source.status === 'unavailable') return 'Unavailable';
  return source.status === 'ok' ? 'Available' : source.status === 'partial' ? 'Partial' : 'Failed';
}

function SourceHealthDialog({ health, loading, error, refreshing, feeds, onClose, onRefresh, onCopy }: { health: SourceHealth | null; loading: boolean; error: string; refreshing: boolean; feeds: NonNullable<AtlasState['corpus']['feeds']>; onClose: () => void; onRefresh: () => void; onCopy: () => void }) {
  const failures = feeds.filter(feed => !['ok', 'cached'].includes(feed.status));
  return <section className="health-modal" role="dialog" aria-modal="true" aria-labelledby="health-title">
    <div className="modal-header"><div><span className="eyebrow">Public data</span><h2 id="health-title">Source health</h2></div><IconButton label="Close source health" onClick={onClose}><X size={16}/></IconButton></div>
    {loading && !health && <div className="health-loading" role="status"><Loader2 size={15} className="spin"/>Checking sources</div>}
    {error && <p className="health-error" role="alert">{error}</p>}
    {health && <>
      <div className="health-summary"><span>{health.sources.reduce((sum, source) => sum + source.recordCount, 0).toLocaleString()} records</span><span>{health.analysis.requestCount.toLocaleString()} requests</span><span>{health.analysis.problemCount.toLocaleString()} problems</span></div>
      {health.analysis.pendingCount > 0 && <div className="health-analysis"><span>{health.analysis.pendingCount.toLocaleString()} posts awaiting analysis</span><span>{health.analysis.analyzedCount.toLocaleString()} analyzed</span></div>}
      {health.analysis.verifiedCurrentGroups10plus !== undefined && <div className="health-analysis"><span>{health.analysis.verifiedCurrentGroups10plus} groups with 10+ recent requesters</span></div>}
      <div className="health-sources">{health.sources.map(source => <article key={source.source} className={`health-source ${source.status}`}>
        <div className="health-source-title"><span><SourceIcon source={source.source}/>{source.name}</span><small>{healthLabel(source)}</small></div>
        <div className="health-source-counts"><span>{source.recordCount.toLocaleString()} records</span><span>{source.requestCount.toLocaleString()} requests</span>{(source.datasetCount || 0) > 0 && <span>{source.datasetCount} imported</span>}</div>
        {source.message && <p>{source.message}</p>}
        <div className="health-source-footer">{source.lastFetchedAt ? <span>Updated {niceDate(source.lastFetchedAt)}</span> : source.lastAttemptAt ? <span>Tried {niceDate(source.lastAttemptAt)}</span> : null}{source.feedsOk + source.feedsFailed > 0 && <span>{source.feedsOk}/{source.feedsOk + source.feedsFailed} feeds available</span>}{source.retryAt && <span>Retry {new Date(source.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}</div>
      </article>)}</div>
      {failures.length > 0 && <details className="health-details"><summary>{failures.length} collection {failures.length === 1 ? 'issue' : 'issues'}<ChevronDown size={11}/></summary><div>{failures.map((feed, index) => <div key={`${feed.source}:${feed.query}:${index}`}><strong>{sourceName(feed.source)}</strong><span>{feed.query}</span><small>{feed.error || feed.status}</small></div>)}</div></details>}
      <div className="health-footer"><span>Checked {niceDate(health.generatedAt)}</span><div><IconButton label="Copy source diagnostics" onClick={onCopy}><Copy size={14}/></IconButton><button className="secondary" disabled={refreshing || loading} onClick={onRefresh}><RefreshCw size={13} className={refreshing ? 'spin' : ''}/>{refreshing ? 'Refreshing' : 'Refresh sources'}</button></div></div>
    </>}
  </section>;
}

function DraftEditor({ lead, state, channel, setChannel, onError, notify, onAgent }: { lead: Lead; state: AtlasState; channel: 'dm' | 'email'; setChannel: (channel: 'dm' | 'email') => void; onError: (e: unknown) => void; notify: (s: string) => void; onAgent: () => void }) {
  const saved = state.drafts[`${lead.id}:${channel}`];
  const [body, setBody] = useState(saved?.body || ''), [subject, setSubject] = useState(saved?.subject || ''), [recipient, setRecipient] = useState(saved?.recipient || state.profiles[lead.id]?.email || '');
  const [saving, setSaving] = useState(false), [copied, setCopied] = useState(false);
  useEffect(() => { if (saved) { setBody(saved.body); setSubject(saved.subject); setRecipient(saved.recipient); } }, [saved?.updatedAt]);
  const save = async () => { setSaving(true); try { await api('draft', { leadId: lead.id, channel, subject, body, recipient }); notify('Draft saved'); } catch (e) { onError(e); } finally { setSaving(false); } };
  const copy = async () => { try { await navigator.clipboard.writeText(channel === 'email' ? `Subject: ${subject}\n\n${body}` : body); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch (e) { onError(e); } };
  return <div className="draft-editor"><div className="draft-channel"><button className={channel === 'dm' ? 'current' : ''} onClick={() => setChannel('dm')}>DM / reply</button><button className={channel === 'email' ? 'current' : ''} onClick={() => setChannel('email')}>Email</button><button className="draft-agent" onClick={onAgent} title="Draft with Atlas"><AtlasMark small/></button></div>{channel === 'email' && <><input aria-label="Recipient email" type="email" placeholder={state.profiles[lead.id]?.email ? 'Public email' : 'No email available. Enter if known.'} value={recipient} onChange={e => setRecipient(e.target.value)}/><input aria-label="Email subject" placeholder="Subject" value={subject} onChange={e => setSubject(e.target.value)}/></>}<textarea aria-label="Message draft" rows={9} placeholder="Write a conversation starter, or ask Atlas to draft one." value={body} onChange={e => setBody(e.target.value)}/><div className="draft-footer"><a className="text-link muted" href={lead.profileUrl} target="_blank" rel="noreferrer">Public profile<ExternalLink size={11}/></a><span>Draft only</span></div><div className="inspector-actions"><button className="secondary" disabled={!body || saving} onClick={save}>{saving ? <Loader2 size={12} className="spin"/> : <Check size={12}/>}Save</button><button className="primary small" disabled={!body} onClick={copy}>{copied ? <Check size={13}/> : <Copy size={13}/>} {copied ? 'Copied' : 'Copy'}</button></div></div>;
}

function Provenance({ source }: { source: Source }) {
  return source.dataset ? <div className="source-provenance">Dataset: <a href={source.dataset.url} target="_blank" rel="noreferrer">{source.dataset.name}</a> · {source.dataset.license}</div> : source.license ? <div className="source-provenance"><a href={source.licenseUrl} target="_blank" rel="noreferrer">{source.license}</a> · {source.author}</div> : null;
}
function interleaveSources(records: Source[]): Source[] {
  const groups = [...new Set(records.map(r => r.source))].map(source => records.filter(r => r.source === source));
  return Array.from({ length: Math.max(0, ...groups.map(g => g.length)) }, (_, i) => groups.map(g => g[i])).flat().filter((r): r is Source => Boolean(r)).slice(0, 100);
}
