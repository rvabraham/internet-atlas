type GraphSource = { id: string; topicId: string; source: string; authorId: string; title: string; text: string; author: string };
type GraphGroup = { id: string; sourceIds: string[]; label: string; workflow?: string; problem?: string; desiredOutcome?: string };
export function discoveryVisibility(options: {
  corpus: { records: GraphSource[]; topics: { id: string }[]; signals?: GraphGroup[] };
  shortlists?: { problemId: string; sourceIds: string[]; label: string; workflow?: string; problem?: string; desiredOutcome?: string }[];
  selected?: string | null; query?: string; searchNodeIds?: string[] | null;
  relatedIds?: string[]; referencedIds?: string[]; pulseIds?: string[];
  topicId?: string | null; sourceFilters: string[];
}): { focused: boolean; visibleIds: Set<string>; sourceIds: Set<string>; topicCounts: Map<string, number> };
