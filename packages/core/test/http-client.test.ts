import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FetchHttpClient } from "../src/index.js";

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

let target: string;
let elsewhere: string;
let elsewhereHits = 0;
const servers: Server[] = [];

beforeAll(async () => {
  const other = createServer((_request, response) => { elsewhereHits++; response.end("leaked"); });
  elsewhere = await listen(other);
  const main = createServer((request, response) => {
    if (request.url === "/same") { response.writeHead(302, { location: "/final" }); response.end(); return; }
    if (request.url === "/cross") { response.writeHead(302, { location: `${elsewhere}/steal` }); response.end(); return; }
    response.end(`final:${request.method}`);
  });
  target = await listen(main);
  servers.push(other, main);
});
afterAll(() => { for (const server of servers) server.close(); });

describe("FetchHttpClient redirects", () => {
  it("follows a redirect within the target's origin", async () => {
    const response = await new FetchHttpClient().request({ method: "GET", url: `${target}/same`, headers: {} });
    expect(response.status).toBe(200);
    expect(response.body).toBe("final:GET");
  });

  it("never follows a redirect to another origin", async () => {
    const response = await new FetchHttpClient().request({ method: "GET", url: `${target}/cross`, headers: {} });
    expect(response.status).toBe(302);
    expect(elsewhereHits).toBe(0);
  });
});

describe("FetchHttpClient retries", () => {
  it("retries a safe method after a dropped connection, but never re-sends a write", async () => {
    let hits = 0;
    const flaky = createServer((request, response) => {
      hits++;
      if (hits % 2 === 1) { request.socket.destroy(); return; }
      response.end("ok");
    });
    const url = await listen(flaky);
    servers.push(flaky);
    const client = new FetchHttpClient({ retries: 1 });

    const response = await client.request({ method: "GET", url, headers: { connection: "close" } });
    expect(response.body).toBe("ok");
    expect(hits).toBe(2);

    await expect(client.request({ method: "PUT", url, headers: { connection: "close" } })).rejects.toThrow();
    expect(hits).toBe(3);
  });
});
