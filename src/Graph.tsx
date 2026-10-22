import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { DataSet } from 'vis-data';
import { Network, type Options, type Node, type Edge } from 'vis-network';
import type { AtlasState, GraphHandle, View } from './types';

type Props = { state: AtlasState; view: View; topicId: string | null; sourceFilters: string[]; selected: string | null; query: string; referencedIds: string[]; onSelect: (id: string | null) => void; onReady: () => void };
const short = (s: string, n = 32) => s.length > n ? s.slice(0, n - 1) + '…' : s;
const alpha = (color: string, opacity: string) => color + opacity;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const randomFor = (key: string) => {
  let value = 2166136261;
  for (const char of key) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return () => { value += 0x6D2B79F5; let n = Math.imul(value ^ value >>> 15, 1 | value); n ^= n + Math.imul(n ^ n >>> 7, 61 | n); return ((n ^ n >>> 14) >>> 0) / 4294967296; };
};
const normalPair = (random: () => number) => {
  const radius = Math.sqrt(-2 * Math.log(Math.max(.0001, random()))), angle = random() * Math.PI * 2;
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
};

export const AtlasGraph = forwardRef<GraphHandle, Props>(function AtlasGraph({ state, view, topicId, sourceFilters, selected, query, referencedIds, onSelect, onReady }, ref) {
  const element = useRef<HTMLDivElement>(null), network = useRef<Network | null>(null);
  const nodeData = useRef(new DataSet<Node>()), edgeData = useRef(new DataSet<Edge>());
  const lastGraph = useRef('');
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect;
  const onReadyRef = useRef(onReady); onReadyRef.current = onReady;
  const stateRef = useRef(state); stateRef.current = state;
  const referenceKey = referencedIds.join('|');
  const references = useRef(new Set<string>()); references.current = new Set(referencedIds);
  const pulses = useRef(new Map<string, number[]>()), pulseFrame = useRef<number | null>(null);
  const hubIds = useRef<string[]>([]);
  useImperativeHandle(ref, () => ({
    pulse: ids => {
      const n = network.current; if (!n) return;
      const now = performance.now();
      for (const id of new Set(ids)) {
        if (!nodeData.current.get(id)) {
          const source = stateRef.current.corpus.records.find(source => source.id === id);
          if (!source) continue;
          const owner = stateRef.current.leads.find(lead => lead.sourceIds.includes(id));
          const origin = owner ? n.getPositions([owner.id])[owner.id] : { x: 0, y: 0 };
          const [x, y] = normalPair(randomFor(id));
          const color = stateRef.current.corpus.topics.find(topic => topic.id === source.topicId)?.color || '#aaa';
          nodeData.current.add({ id, x: (origin?.x || 0) + x * 70, y: (origin?.y || 0) + y * 70, size: 5, color, label: '' });
          if (owner) edgeData.current.add({ id: `pulse-author:${id}`, from: owner.id, to: id, color: { color: color + '66' } });
        }
        pulses.current.set(id, [...(pulses.current.get(id) || []).filter(start => now - start < 1400), now].slice(-4));
      }
      n.redraw();
    },
    fit: () => network.current?.fit({ animation: reduced() ? false : { duration: 350, easingFunction: 'easeInOutQuad' } }),
    zoom: direction => { const n = network.current; if (n) n.moveTo({ scale: Math.max(.15, Math.min(3, n.getScale() * (direction > 0 ? 1.25 : .8))), animation: reduced() ? false : { duration: 180, easingFunction: 'easeInOutQuad' } }); },
    focus: ids => {
      const n = network.current; if (!n || !ids.length) return;
      const found = [...new Set(ids.flatMap(id => nodeData.current.get(id) ? [id] : stateRef.current.corpus.signals?.find(signal => signal.id === id)?.sourceIds || []).filter(id => nodeData.current.get(id)))]; if (!found.length) return;
      const inspector = element.current?.parentElement?.querySelector('.inspector');
      const width = element.current?.clientWidth || 1;
      const panelWidth = inspector?.getBoundingClientRect().width || 0;
      const offset = { x: panelWidth ? Math.min(panelWidth / 2 + 12, width * .34) : 0, y: 0 };
      const animation = reduced() ? false : { duration: 400, easingFunction: 'easeInOutQuad' as const };
      n.selectNodes(found);
      if (found.length === 1) n.focus(found[0], { scale: 1.05, offset, animation });
      else {
        n.fit({ nodes: found, animation: false });
        n.moveTo({ position: n.getViewPosition(), scale: n.getScale() * Math.max(.3, (width - panelWidth - 40) / width), offset, animation });
      }
    },
  }));
  useEffect(() => {
    if (!element.current) return;
    const options: Options = {
      autoResize: true, layout: { improvedLayout: false, randomSeed: 17 },
      nodes: { shape: 'dot', borderWidth: 1, chosen: { label: false, node: (values: any) => { values.borderWidth = 3; values.shadow = true; values.shadowColor = '#ffffff30'; values.shadowSize = 18; } }, font: { face: 'Geist Mono, monospace', size: 12, color: '#b3b3b1', strokeWidth: 4, strokeColor: '#151515' }, shadow: false },
      edges: { color: { color: '#ffffff12', highlight: '#a6a6a655', hover: '#a6a6a655', inherit: false }, width: .65, selectionWidth: 1.5, smooth: false },
      interaction: { hover: true, tooltipDelay: 150, hideEdgesOnDrag: true, navigationButtons: false, keyboard: false, multiselect: false, zoomSpeed: .6 },
      physics: { enabled: false },
    };
    const n = new Network(element.current, { nodes: nodeData.current, edges: edgeData.current }, options); network.current = n;
    n.on('click', ({ nodes }) => onSelectRef.current(nodes[0] ? String(nodes[0]) : null));
    n.on('hoverNode', () => { if (element.current) element.current.style.cursor = 'pointer'; });
    n.on('blurNode', () => { if (element.current) element.current.style.cursor = 'grab'; });
    n.on('afterDrawing', (ctx: CanvasRenderingContext2D) => {
      const scale = n.getScale();
      const hubs = hubIds.current.map(id => nodeData.current.get(id)).filter((node): node is NonNullable<typeof node> => node !== null && !node.hidden);
      for (const node of hubs) {
        const position = n.getPositions([node.id!])[node.id!]; if (!position) continue;
        const data = node as any;
        ctx.save(); ctx.globalAlpha = data.opacity ?? 1; ctx.font = `400 ${11 / scale}px "Geist Mono", monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const y = position.y + (node.size || 15) + 10 / scale;
        ctx.lineWidth = 5 / scale; ctx.strokeStyle = '#151515'; ctx.strokeText(data.atlasLabel, position.x, y);
        ctx.fillStyle = data.atlasColor; ctx.fillText(data.atlasLabel, position.x, y); ctx.restore();
      }
      for (const id of references.current) {
        const node = nodeData.current.get(id); if (!node || node.hidden) continue;
        const position = n.getPositions([id])[id]; if (!position) continue;
        ctx.save(); ctx.globalAlpha = 1; ctx.beginPath();
        ctx.arc(position.x, position.y, (node.size || 5) + 4 / scale, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.8 / scale;
        ctx.shadowColor = '#ffffff55'; ctx.shadowBlur = 7 / scale; ctx.stroke(); ctx.restore();
      }
      const now = performance.now();
      for (const [id, starts] of pulses.current) {
        const active = starts.filter(start => now - start < (reduced() ? 650 : 1400));
        if (!active.length) { pulses.current.delete(id); continue; }
        pulses.current.set(id, active);
        const node = nodeData.current.get(id), position = n.getPositions([id])[id];
        if (!node || !position) continue;
        const age = now - active[active.length - 1];
        const phase = reduced() ? 1 : (Math.cos(age / 1400 * Math.PI * 6) + 1) / 2;
        ctx.save(); ctx.globalAlpha = .15 + phase * .85; ctx.beginPath();
        ctx.arc(position.x, position.y, (node.size || 5) + (5 + phase * 7) / scale, 0, Math.PI * 2);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = (1.5 + phase) / scale;
        ctx.shadowColor = '#ffffff'; ctx.shadowBlur = phase * 16 / scale; ctx.stroke(); ctx.restore();
      }
      if (pulses.current.size && pulseFrame.current === null) pulseFrame.current = requestAnimationFrame(() => { pulseFrame.current = null; if (network.current === n) n.redraw(); });
    });
    return () => { if (pulseFrame.current !== null) cancelAnimationFrame(pulseFrame.current); pulseFrame.current = null; pulses.current.clear(); n.destroy(); network.current = null; lastGraph.current = ''; };
  }, []);
  useEffect(() => {
    const n = network.current; if (!n) return;
    const graphKey = `${view}:${state.corpus.analysis?.generatedAt}:${state.corpus.fetchedAt}:${state.idea?.revision}:${state.leads.map(l => l.id).join('|')}`;
    if (lastGraph.current === graphKey) return;
    lastGraph.current = graphKey;
    const nodes: Node[] = [], edges: Edge[] = [];
    const topics = state.corpus.topics;
    if (view === 'discover') {
      const recordMap = new Map(state.corpus.records.map(r => [r.id, r]));
      const positionMap = new Map<string, { x: number; y: number }>();
      const centers = [[-960,-560],[-170,-750],[780,-550],[1080,340],[330,970],[-650,810],[-1200,170],[-330,30],[300,240]];
      topics.forEach((topic, i) => {
        const [x, y] = centers[i % centers.length];
        const sources = state.corpus.records.filter(r => r.topicId === topic.id);
        nodes.push({ id: topic.id, label: '', x, y, fixed: true, size: 13 + Math.sqrt(sources.length) * .5, color: { background: topic.color, border: alpha(topic.color, '33'), highlight: { background: topic.color, border: '#ffffff' } }, borderWidth: 5, atlasHub: true, atlasLabel: topic.name, atlasColor: topic.color } as Node);
        sources.forEach(source => {
          // Soft, uneven neighborhoods follow real request/author links without circular boundaries.
          const [u, v] = normalPair(randomFor(source.signalId || source.authorId || source.id));
          const [jx, jy] = normalPair(randomFor(source.id + ':offset'));
          const spread = 190 + Math.sqrt(sources.length) * 5;
          const rotation = i * .73, dx = u * spread * 1.2 + v * spread * .28, dy = v * spread * .7;
          const point = { x: x + dx * Math.cos(rotation) - dy * Math.sin(rotation) + jx * 28, y: y + dx * Math.sin(rotation) + dy * Math.cos(rotation) + jy * 28 };
          positionMap.set(source.id, point);
          nodes.push({ id: source.id, ...point, label: '', size: source.request ? 5 : 3.5, color: { background: alpha(topic.color, source.request ? 'd0' : '75'), border: alpha(topic.color, '10'), highlight: { background: topic.color, border: '#f0efe9' }, hover: { background: topic.color, border: '#f0efe9' } } });
          edges.push({ id: `topic:${source.id}`, from: topic.id, to: source.id, color: { color: alpha(topic.color, '09'), highlight: alpha(topic.color, '90') } });
        });
      });
      const authors = new Map<string, string[]>();
      for (const source of state.corpus.records) {
        const ids = authors.get(source.authorId) || []; ids.push(source.id); authors.set(source.authorId, ids);
      }
      for (const [author, ids] of authors) {
        const point = positionMap.get(ids[0]); if (!point) continue;
        const hash = [...author].reduce((sum, c) => sum + c.charCodeAt(0), 0);
        nodes.push({ id: author, x: point.x + Math.cos(hash) * 20, y: point.y + Math.sin(hash) * 20, size: ids.length > 1 ? 3 : 1.7, color: { background: '#777773', border: '#777775' }, label: '', opacity: .55 });
        ids.forEach(id => edges.push({ id: `${author}:${id}`, from: author, to: id, color: { color: '#88888813' }, width: .5 }));
      }
      // Dashed links represent semantic grouping, separate from observed authorship.
      for (const signal of state.corpus.signals || []) {
        if (signal.sourceIds.length < 2) continue;
        const point = positionMap.get(signal.representativeId); if (!point) continue;
        const color = topics.find(t => t.id === signal.topicId)?.color || '#bbb7ac';
        const tooltip = document.createElement('div'); tooltip.textContent = `${signal.label}: ${signal.requesterCount} requesters`;
        nodes.push({ id: signal.id, x: point.x + 35, y: point.y - 35, shape: 'diamond', size: 7 + Math.min(12, Math.sqrt(signal.requesterCount)), label: '', color: { background: color, border: '#ffffff55' }, title: tooltip });
        for (const id of signal.sourceIds) if (recordMap.has(id)) edges.push({ id: `request:${signal.id}:${id}`, from: signal.id, to: id, dashes: [3, 5], color: { color: color + '70' }, width: .9 });
      }
    } else if (state.idea) {
      nodes.push({ id: 'idea', label: '', x: 0, y: 0, fixed: true, size: 21, shape: 'diamond', color: { background: '#e1dfd7', border: '#f3f1e7' }, font: { size: 16, color: '#e1dfd7', vadjust: 12 }, borderWidth: 2, mass: 8, atlasHub: true, atlasLabel: short(state.idea.title, 38), atlasColor: '#d0cbbb' } as Node);
      state.leads.forEach((lead, i) => {
        const topic = topics.find(t => t.id === lead.topicId) || topics[0];
        const angle = i * 2.39996 - Math.PI / 2;
        const r = 135 + Math.sqrt(i + 1) * 66, x = Math.cos(angle) * r * 1.35, y = Math.sin(angle) * r;
        nodes.push({ id: lead.id, label: lead.name, x, y, size: 10 + Math.min(6, lead.sourceIds.length * 1.5), color: { background: topic.color, border: alpha(topic.color, '30'), highlight: { background: topic.color, border: '#ffffff' }, hover: { background: topic.color, border: '#ffffff' } }, borderWidth: 4, font: { size: 12, color: '#c3c1bd', vadjust: 5 } });
        edges.push({ id: `fit:${lead.id}`, from: 'idea', to: lead.id, dashes: [4, 7], color: { color: alpha(topic.color, '38') }, length: r, width: .9 });
        lead.sourceIds.slice(0, 3).forEach((id, j) => {
          const source = state.corpus.records.find(s => s.id === id); if (!source) return;
          const a = angle + (j - .7) * .4;
          nodes.push({ id, label: '', x: x + Math.cos(a) * 70, y: y + Math.sin(a) * 70, size: 4.5, color: { background: alpha(topic.color, '99'), border: topic.color }, shape: 'dot' });
          edges.push({ id: `author:${lead.id}:${id}`, from: lead.id, to: id, color: { color: alpha(topic.color, '55') }, length: 55 });
        });
      });
    }
    hubIds.current = nodes.filter(node => (node as any).atlasHub).map(node => String(node.id));
    nodeData.current.clear(); edgeData.current.clear(); nodeData.current.add(nodes); edgeData.current.add(edges);
    n.setOptions({ physics: { enabled: false } });
    requestAnimationFrame(() => { if (network.current === n) { n.fit({ animation: false }); onReadyRef.current(); } });
  }, [state.corpus.fetchedAt, state.corpus.analysis?.generatedAt, state.idea?.revision, state.leads, view]);
  useEffect(() => {
    const n = network.current; if (!n) return;
    // A cited record is always visible, including evidence beyond a person's first three sources.
    for (const id of referencedIds) {
      if (nodeData.current.get(id)) continue;
      const source = state.corpus.records.find(r => r.id === id); if (!source) continue;
      const owner = state.leads.find(l => l.sourceIds.includes(id));
      const origin = owner ? n.getPositions([owner.id])[owner.id] : { x: -380, y: -150 };
      const color = state.corpus.topics.find(t => t.id === source.topicId)?.color || '#b5a1ec';
      const hash = [...id].reduce((sum, c) => sum + c.charCodeAt(0), 0);
      nodeData.current.add({ id, x: (origin?.x || 0) + Math.cos(hash) * 90, y: (origin?.y || 0) + Math.sin(hash) * 90, size: 5, color: {background: color, border: color}, label: '' });
      if (owner) edgeData.current.add({ id: `cited-author:${id}`, from: owner.id, to: id, color: {color: color + '66'} });
    }
    const sourceMap = new Map(state.corpus.records.map(s => [s.id, s]));
    const authorMap = new Map<string, typeof state.corpus.records>();
    for (const source of state.corpus.records) { const records = authorMap.get(source.authorId) || []; records.push(source); authorMap.set(source.authorId, records); }
    const signalMap = new Map((state.corpus.signals || []).map(s => [s.id, s]));
    const leadMap = new Map(state.leads.map(l => [l.id, l]));
    const signalMembers = signalMap.get(selected || '')?.sourceIds;
    const neighborhoods = signalMembers ? new Set([selected, ...signalMembers, ...signalMembers.map(id => sourceMap.get(id)?.authorId)]) : selected && nodeData.current.get(selected) ? new Set([selected, ...n.getConnectedNodes(selected) as string[]]) : null;
    const lowerQuery = query.toLowerCase().trim();
    const updates: any[] = nodeData.current.get().map(node => {
      const id = String(node.id), s = sourceMap.get(id), lead = leadMap.get(id), topic = state.corpus.topics.find(t => t.id === id);
      const authorSources = !s && !topic && !lead && id !== 'idea' ? authorMap.get(id) || [] : [];
      const matchesTopic = !topicId || signalMap.get(id)?.topicId === topicId || s?.topicId === topicId || topic?.id === topicId || lead?.topicId === topicId || authorSources.some(s => s.topicId === topicId);
      const matchesSource = s ? sourceFilters.includes(s.source) : signalMap.has(id) ? signalMap.get(id)!.sourceIds.some(id => sourceFilters.includes(sourceMap.get(id)?.source || '')) : authorSources.length ? authorSources.some(r => sourceFilters.includes(r.source)) : true;
      const searchTerms = lowerQuery.split(/\s+/).filter(Boolean);
      const signal = signalMap.get(id);
      const matchesQuery = !lowerQuery || searchTerms.every(term => `${s?.title || ''} ${s?.text || ''} ${lead?.name || ''} ${topic?.name || ''} ${signal?.label || ''} ${signal?.workflow || ''} ${signal?.problem || ''} ${signal?.desiredOutcome || ''}`.toLowerCase().includes(term));
      const cited = references.current.has(id);
      return { id, hidden: !cited && !signalMembers?.includes(id) && (!matchesTopic || !matchesSource), opacity: cited ? 1 : neighborhoods ? neighborhoods.has(id) ? 1 : .13 : !matchesQuery ? .12 : 1 };
    });
    nodeData.current.update(updates);
    if (selected && nodeData.current.get(selected)) n.selectNodes([selected]); else n.unselectAll();
    n.redraw();
  }, [topicId, sourceFilters, selected, query, state, view, referenceKey]);
  return <div className="graph-canvas" ref={element} aria-label={view === 'discover' ? 'Public evidence graph. Use the topics and evidence list to explore with a keyboard.' : 'Leads graph. Select a requester from the list to inspect their evidence.'} />;
});
