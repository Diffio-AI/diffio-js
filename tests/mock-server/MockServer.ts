import type { HttpHandler, RequestHandlerOptions } from "msw";
import type { SetupServer } from "msw/node";

import { mockEndpointBuilder } from "./mockEndpointBuilder";

export interface MockServerOptions {
  baseUrl: string;
  server: SetupServer;
}

export class MockServer {
  private readonly server: SetupServer;
  public readonly baseUrl: string;

  constructor({ baseUrl, server }: MockServerOptions) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    this.server = server;
  }

  /** Installs hand-written MSW handlers, for stateful fakes such as the edge upload Worker. */
  useHandlers(...handlers: HttpHandler[]): void {
    this.server.use(...handlers);
  }

  mockEndpoint(options?: RequestHandlerOptions): ReturnType<typeof mockEndpointBuilder> {
    const builder = mockEndpointBuilder({
      once: options?.once ?? true,
      onBuild: (handler) => {
        this.server.use(handler);
      }
    }).baseUrl(this.baseUrl);
    return builder;
  }
}
