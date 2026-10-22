import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { DataSet } from 'vis-data';
import { Network, type Options, type Node, type Edge } from 'vis-network';
import type { AtlasState, GraphHandle, View } from './types';

type Props = { state: AtlasState; view: View; topicId: string | null; sourceFilters: string[]; selected: string | null; query: string; onSelect: (id: string | null) => void; onReady: () => void };
const short = (s: string, n = 32) => s.length > n ? s.slice(0, n - 1) + '…' : s;
const alpha = (color: string, opacity: string) => color + opacity;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const AtlasGraph = forwardRef<GraphHandle, Props>(function AtlasGraph({ state, view, topicId, sourceFilters, selected, query, onSelect, onReady }, ref) {
  const element = useRef<HTMLDivElement>(null), network = useRef<Network | null>(null);
  const nodeData = useRef(new DataSet<Node>()), edgeData = useRef(new DataSet<Edge>());
  const lastGraph = useRef('');
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect;
  const onReadyRef = useRef(onReady); onReadyRef.current = onReady;
  const stateRef = useRef(state); stateRef.current = state;
  useImperativeHandle(ref, () => ({
    fit: () => network.current?.fit({ animation: reduced() ? false : { duration: 350, easingFunction: 'easeInOutQuad' } }),
    zoom: direction => { const n = network.current; if (n) n.moveTo({ scale: Math.max(.15, Math.min(3, n.getScale() * (direction > 0 ? 1.25 : .8))), animation: reduced() ? false : { duration: 180, easingFunction: 'easeInOutQuad' } }); },
    focus: ids => { const n = network.current; if (!n || !ids.length) return; const found = ids.filter(id => nodeData.current.get(id)); if (!found.length) return; n.selectNodes(found); if (found.length === 1) n.focus(found[0], { scale: 1.05, animation: reduced() ? false : { duration: 400, easingFunction: 'easeInOutQuad' } }); else n.fit({ nodes: found, animation: reduced() ? false : { duration: 400, easingFunction: 'easeInOutQuad' } }); },
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
      const hubs = nodeData.current.get().filter(node => (node as any).atlasHub && !node.hidden);
      for (const node of hubs) {
        const position = n.getPositions([node.id!])[node.id!]; if (!position) continue;
        const data = node as any;
        ctx.save(); ctx.globalAlpha = data.opacity ?? 1; ctx.font = `400 ${11 / scale}px "Geist Mono", monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const y = position.y + (node.size || 15) + 10 / scale;
        ctx.lineWidth = 5 / scale; ctx.strokeStyle = '#151515'; ctx.strokeText(data.atlasLabel, position.x, y);
        ctx.fillStyle = data.atlasColor; ctx.fillText(data.atlasLabel, position.x, y); ctx.restore();
      }
    });
    return () => { n.destroy(); network.current = null; lastGraph.current = ''; };
  }, []);
  useEffect(() => {
    const n = network.current; if (!n) return;
    const graphKey = `${view}:${state.corpus.fetchedAt}:${state.idea?.revision}:${state.leads.map(l => l.id).join('|')}`;
    if (lastGraph.current === graphKey) return;
    lastGraph.current = graphKey;
    const nodes: Node[] = [], edges: Edge[] = [];
    const topics = state.corpus.topics;
    if (view === 'discover') {
      const centers = [[-450,-205],[-130,-270],[235,-230],[480,-15],[280,240],[-70,265],[-410,155],[-40,20]];
      topics.forEach((topic, i) => {
        const [x, y] = centers[i % centers.length];
        const sources = state.corpus.records.filter(r => r.topicId === topic.id);
        nodes.push({ id: topic.id, label: '', x, y, fixed: true, size: 11 + Math.sqrt(sources.length) * .7, color: { background: topic.color, border: alpha(topic.color, '33'), highlight: { background: topic.color, border: '#ffffff' }, hover: { background: topic.color, border: '#ffffff99' } }, borderWidth: 5, font: { size: 15, color: topic.color, vadjust: 5 }, mass: 4, atlasHub: true, atlasLabel: topic.name, atlasColor: topic.color } as Node);
        sources.forEach((source, j) => {
          const angle = j * 2.39996, r = 38 + 18 * Math.sqrt(j);
          nodes.push({ id: source.id, x: x + Math.cos(angle) * r * (i % 2 ? 1.1 : .95), y: y + Math.sin(angle) * r * (i % 2 ? .86 : 1.03), label: '', size: 3.8 + Math.min(4, Math.log2(1 + source.replies)), color: { background: alpha(topic.color, 'c0'), border: alpha(topic.color, '10'), highlight: { background: topic.color, border: '#f0efe9' }, hover: { background: topic.color, border: '#f0efe9' } }, font: { size: 10, color: '#838381' }, mass: 1 });
          edges.push({ id: `topic:${source.id}`, from: topic.id, to: source.id, color: { color: alpha(topic.color, '20'), highlight: alpha(topic.color, '90') } });
        });
      });
      const authors = new Map<string, string[]>();
      for (const source of state.corpus.records) authors.set(source.authorId, [...(authors.get(source.authorId) || []), source.id]);
      for (const [author, ids] of authors) {
        const source = state.corpus.records.find(r => r.id === ids[0])!;
        const topic = topics.find(t => t.id === source.topicId)!;
        const firstNode = nodes.find(n => n.id === source.id)!;
        const hash = [...author].reduce((sum, c) => sum + c.charCodeAt(0), 0);
        nodes.push({ id: author, x: firstNode.x! + Math.cos(hash) * (18 + hash % 20), y: firstNode.y! + Math.sin(hash) * (18 + hash % 20), size: ids.length > 1 ? 3.5 : 2, color: { background: '#777773', border: '#777775' }, label: '', opacity: .6, shape: 'dot' });
        ids.forEach(id => edges.push({ id: `${author}:${id}`, from: author, to: id, color: { color: '#88888814' }, length: 27, width: .5 }));
      }
      // Sparse lexical bridges are inferences, distinct from authored/source edges.
      const vocabulary = (s: string) => new Set((s.toLowerCase().match(/[a-z]{5,}/g) || []).filter(w => !['their', 'there', 'would', 'about', 'which', 'these', 'https', 'github', 'using'].includes(w)));
      const records = state.corpus.records;
      const words = records.map(r => vocabulary(`${r.title} ${r.text.slice(0, 500)}`));
      let count = 0;
      for (let i = 0; i < records.length; i++) {
        const candidates = records.map((r, j) => ({ j, common: [...words[i]].filter(w => words[j].has(w)).length })).filter(({ j, common }) => i < j && records[i].topicId === records[j].topicId && common >= 5).sort((a, b) => b.common - a.common).slice(0, 2);
        for (const { j } of candidates) {
          const color = topics.find(t => t.id === records[i].topicId)!.color;
          edges.push({ id: `similar:${i}:${j}`, from: records[i].id, to: records[j].id, dashes: [2, 4], width: .55, color: { color: alpha(color, '20') } });
        }
      }
      for (let i = 0; i < records.length && count < 32; i++) {
        for (let j = i + 1; j < records.length && count < 32; j++) {
          if (records[i].topicId === records[j].topicId) continue;
          const common = [...words[i]].filter(w => words[j].has(w));
          if (common.length >= 7 && common.length / Math.max(1, Math.min(words[i].size, words[j].size)) > .23) {
            edges.push({ id: `related:${i}:${j}`, from: records[i].id, to: records[j].id, dashes: [3, 5], width: .55, color: { color: '#b4afcb25' }, length: 220 }); count++; break;
          }
        }
      }
    } else if (state.idea) {
      nodes.push({ id: 'idea', label: '', x: 0, y: 0, fixed: true, size: 21, shape: 'diamond', color: { background: '#e1dfd7', border: '#f3f1e7' }, font: { size: 16, color: '#e1dfd7', vadjust: 12 }, borderWidth: 2, mass: 8, atlasHub: true, atlasLabel: short(state.idea.title, 38), atlasColor: '#d0cbbb' } as Node);
      state.leads.forEach((lead, i) => {
        const topic = topics.find(t => t.id === lead.topicId)!;
        const angle = i * Math.PI * 2 / state.leads.length - Math.PI / 2;
        const r = 160 + (i % 2) * 65, x = Math.cos(angle) * r * 1.5, y = Math.sin(angle) * r;
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
    nodeData.current.clear(); edgeData.current.clear(); nodeData.current.add(nodes); edgeData.current.add(edges);
    n.setOptions({ physics: { enabled: false } });
    requestAnimationFrame(() => { if (network.current === n) { n.fit({ animation: false }); onReadyRef.current(); } });
  }, [state.corpus.fetchedAt, state.idea?.revision, state.leads, view]);
  useEffect(() => {
    const n = network.current; if (!n) return;
    const sourceMap = new Map(state.corpus.records.map(s => [s.id, s]));
    const leadMap = new Map(state.leads.map(l => [l.id, l]));
    const neighborhoods = selected && nodeData.current.get(selected) ? new Set([selected, ...n.getConnectedNodes(selected) as string[]]) : null;
    const lowerQuery = query.toLowerCase().trim();
    const updates: any[] = nodeData.current.get().map(node => {
      const id = String(node.id), s = sourceMap.get(id), lead = leadMap.get(id), topic = state.corpus.topics.find(t => t.id === id);
      const authorSources = !s && !topic && !lead && id !== 'idea' ? state.corpus.records.filter(r => r.authorId === id) : [];
      const matchesTopic = !topicId || s?.topicId === topicId || topic?.id === topicId || lead?.topicId === topicId || authorSources.some(s => s.topicId === topicId);
      const matchesSource = s ? sourceFilters.includes(s.source) : authorSources.length ? authorSources.some(r => sourceFilters.includes(r.source)) : true;
      const searchTerms = lowerQuery.split(/\s+/).filter(Boolean);
      const matchesQuery = !lowerQuery || searchTerms.every(term => `${s?.title || ''} ${s?.text || ''} ${lead?.name || ''} ${topic?.name || ''}`.toLowerCase().includes(term));
      return { id, hidden: !matchesTopic || !matchesSource, opacity: neighborhoods && !neighborhoods.has(id) ? .13 : !matchesQuery ? .12 : 1 };
    });
    nodeData.current.update(updates);
    if (selected && nodeData.current.get(selected)) n.selectNodes([selected]); else n.unselectAll();
  }, [topicId, sourceFilters, selected, query, state, view]);
  return <div className="graph-canvas" ref={element} aria-label={view === 'discover' ? 'Public evidence graph. Use the topics and evidence list to explore with a keyboard.' : 'People graph. Select a person from the list to inspect their evidence.'} />;
});
