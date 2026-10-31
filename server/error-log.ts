export interface ServerErrorRecord {
  at: string;
  method: string;
  path: string;
  status: number;
  message: string;
}

const records: ServerErrorRecord[] = [];
const MAX = 100;

export function recordServerError(entry: ServerErrorRecord): void {
  records.push(entry);
  if (records.length > MAX) records.shift();
}

export function recentServerErrors(limit: number): ServerErrorRecord[] {
  return records.slice(-limit).reverse();
}
