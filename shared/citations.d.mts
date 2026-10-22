export function canonicalSourceUrl(value: string): string | null;
export function citedSourceIds(text: string, records: {id: string; url: string}[]): string[];
export function citedSourceOccurrences(text: string, records: {id: string; url: string}[], complete?: boolean): string[];
