export {};

declare global {
  type PagesFunctionContext<E = unknown> = {
    request: Request;
    env: E;
    data?: Record<string, unknown>;
    params?: Record<string, string>;
    waitUntil?(p: Promise<any>): void;
    next?(): Promise<Response>;
  };

  type PagesFunction<E = unknown> = (
    ctx: PagesFunctionContext<E>
  ) => Promise<Response> | Response;
}
