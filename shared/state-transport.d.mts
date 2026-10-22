export function browserCorpus<T extends object>(corpus: T): T;
export function createStateBroadcaster(initialCorpusIdentity?: object): <T extends { corpus?: object }>(state: T, corpusIdentity?: object) => Partial<T>;
export function createStateReceiver<T extends { corpus: unknown }>(): { receive(patch: Partial<T>): T | null; initialize(snapshot: T): T };
