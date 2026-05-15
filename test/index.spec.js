import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

describe("CouncilHub worker", () => {
	it("responds from the health endpoint (unit style)", async () => {
		const request = new Request("http://example.com/api/test");
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ status: "Worker is alive" });
	});

	it("responds from the health endpoint (integration style)", async () => {
		const response = await SELF.fetch("http://example.com/api/test");
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ status: "Worker is alive" });
	});
});
