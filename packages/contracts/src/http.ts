export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}
export interface HttpResponse {
  status: number;
  ok: boolean;
  body: unknown; // parsed JSON when possible, else undefined
  text: string;
}
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}
