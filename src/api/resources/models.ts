import type { RequestOptions, Transport } from "../../core/transport";
import { Page, PagePromise, type ListResponse } from "../../core/pagination";
import type { Model } from "../types";

export class ModelsResource {
  constructor(private readonly transport: Transport) {}

  /** `GET /v2/models`: every model name with its status, serving model and price. Needs no API key. */
  list(options?: RequestOptions): PagePromise<Model> {
    return PagePromise.from(async () => {
      const response = await this.transport.request<ListResponse<Model>>({
        method: "GET",
        path: "/models",
        idempotent: true,
        noAuth: true,
        options
      });
      return new Page(response, async () => this.list(options));
    });
  }
}
