import { DiffioClient } from "../../src/Client";
import { mockServerPool } from "../mock-server/MockServerPool";

describe("Diffio 4.0 models", () => {
  test.each([
    ["diffio-4.0-flash", "/v1/diffio-4.0-flash-generation"],
    ["diffio-4.0-pro", "/v1/diffio-4.0-pro-generation"]
  ] as const)("%s creates a generation on its own endpoint", async (model, path) => {
    const server = mockServerPool.createServer();
    const client = new DiffioClient({ apiKey: "test", baseUrl: server.baseUrl, maxRetries: 0 });

    server
      .mockEndpoint()
      .post(path)
      .headers({ Authorization: "Bearer test", "Content-Type": "application/json" })
      .jsonBody({ apiProjectId: "proj_123" })
      .respondWith()
      .statusCode(200)
      .jsonBody({ generationId: "gen_40", apiProjectId: "proj_123", modelKey: model, status: "queued" })
      .build();

    const response = await client.generations.create({ apiProjectId: "proj_123", model });
    expect(response).toEqual({ generationId: "gen_40", apiProjectId: "proj_123", modelKey: model, status: "queued" });
  });
});
