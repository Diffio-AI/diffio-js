/** The wire shape of every v2 list: `{"object": "list", "data": [...], "next_cursor": string | null}`. */
export interface ListResponse<T> {
  object: "list";
  data: T[];
  next_cursor: string | null;
}

/**
 * One page of a list. `data` and `next_cursor` are exactly as on the wire. `for await (const item of page)`
 * walks this page and every later one.
 */
export class Page<T> implements ListResponse<T>, AsyncIterable<T> {
  readonly object: "list" = "list";
  readonly data: T[];
  readonly next_cursor: string | null;
  private readonly fetchPage: (cursor: string) => Promise<Page<T>>;

  constructor(response: ListResponse<T>, fetchPage: (cursor: string) => Promise<Page<T>>) {
    this.data = Array.isArray(response?.data) ? response.data : [];
    this.next_cursor = typeof response?.next_cursor === "string" && response.next_cursor ? response.next_cursor : null;
    this.fetchPage = fetchPage;
  }

  hasNextPage(): boolean {
    return this.next_cursor !== null;
  }

  /** Fetches the page after this one; null on the last page. */
  async getNextPage(): Promise<Page<T> | null> {
    return this.next_cursor ? this.fetchPage(this.next_cursor) : null;
  }

  /** Every page from this one on. */
  async *iterPages(): AsyncGenerator<Page<T>, void, undefined> {
    let page: Page<T> | null = this;
    while (page) {
      yield page;
      page = await page.getNextPage();
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    for await (const page of this.iterPages()) {
      for (const item of page.data) yield item;
    }
  }

  toJSON(): ListResponse<T> {
    return { object: "list", data: this.data, next_cursor: this.next_cursor };
  }
}

/**
 * What list methods return: await it for the first `Page`, or `for await` it directly to walk every item of
 * every page (the SDK fetches the next page when it needs it).
 */
export class PagePromise<T> extends Promise<Page<T>> implements AsyncIterable<T> {
  static get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  static from<T>(load: () => Promise<Page<T>>): PagePromise<T> {
    let resolveFn!: (value: Page<T>) => void;
    let rejectFn!: (reason?: unknown) => void;
    const promise = new PagePromise<T>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    load().then(resolveFn, rejectFn);
    return promise;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    const page = await this;
    yield* page;
  }
}
