import { describe, expect, it } from "vitest";
import {
	classifyTurn,
	extractOutputSnippet,
	formatFiles,
	freshTurn,
	parseJsonFromOutput,
	truncate,
	type TurnActivity,
} from "../lib/classify.js";

// ---------------------------------------------------------------------------
// classifyTurn
// ---------------------------------------------------------------------------

describe("classifyTurn", () => {
	it("returns undefined for empty turn", () => {
		expect(classifyTurn(freshTurn())).toBeUndefined();
	});

	it("returns undefined for read-only turn", () => {
		const turn = freshTurn();
		turn.toolCallCount = 3;
		// No files, no bash, no errors — just reads.
		expect(classifyTurn(turn)).toBeUndefined();
	});

	it("returns undefined for single file edit with no other signals", () => {
		const turn = freshTurn();
		turn.files = [{ path: "src/index.ts", action: "edit" }];
		turn.toolCallCount = 1;
		expect(classifyTurn(turn)).toBeUndefined();
	});

	// -- task_completed --

	it("returns task_completed for 2+ file edits", () => {
		const turn = freshTurn();
		turn.files = [
			{ path: "src/a.ts", action: "edit" },
			{ path: "src/b.ts", action: "write" },
		];
		turn.toolCallCount = 2;
		const result = classifyTurn(turn);
		expect(result).toBeDefined();
		expect(result!.eventType).toBe("task_completed");
		expect(result!.payload).toContain("src/a.ts");
		expect(result!.payload).toContain("src/b.ts");
	});

	it("returns task_completed for single file edit + passing tests", () => {
		const turn = freshTurn();
		turn.files = [{ path: "src/foo.ts", action: "edit" }];
		turn.bashCommands = [
			{ command: "npm run test", exitCode: 0, outputSnippet: "3 passed", isError: false },
		];
		turn.toolCallCount = 2;
		const result = classifyTurn(turn);
		expect(result).toBeDefined();
		expect(result!.eventType).toBe("task_completed");
		expect(result!.payload).toContain("tests passed");
	});

	it("returns task_completed for single file edit + passing build", () => {
		const turn = freshTurn();
		turn.files = [{ path: "src/foo.ts", action: "edit" }];
		turn.bashCommands = [
			{ command: "npm run check", exitCode: 0, outputSnippet: "ok", isError: false },
		];
		turn.toolCallCount = 2;
		const result = classifyTurn(turn);
		expect(result).toBeDefined();
		expect(result!.eventType).toBe("task_completed");
		expect(result!.payload).toContain("build/lint clean");
	});

	it("returns task_completed for file edit + 5 tool calls", () => {
		const turn = freshTurn();
		turn.files = [{ path: "src/foo.ts", action: "edit" }];
		turn.toolCallCount = 5;
		const result = classifyTurn(turn);
		expect(result).toBeDefined();
		expect(result!.eventType).toBe("task_completed");
	});

	it("includes tests passed and build clean when both succeed", () => {
		const turn = freshTurn();
		turn.files = [
			{ path: "src/a.ts", action: "edit" },
			{ path: "src/b.ts", action: "edit" },
		];
		turn.bashCommands = [
			{ command: "npx vitest --run", exitCode: 0, outputSnippet: "5 passed", isError: false },
			{ command: "npm run build", exitCode: 0, outputSnippet: "ok", isError: false },
		];
		turn.toolCallCount = 4;
		const result = classifyTurn(turn);
		expect(result!.eventType).toBe("task_completed");
		expect(result!.payload).toContain("tests passed");
		expect(result!.payload).toContain("build/lint clean");
	});

	// -- gotcha_discovered --

	it("returns gotcha_discovered for test failure", () => {
		const turn = freshTurn();
		turn.bashCommands = [
			{
				command: "npm run test",
				exitCode: 1,
				outputSnippet: "FAIL src/foo.test.ts\nTypeError: x is not a function",
				isError: true,
			},
		];
		turn.toolCallCount = 1;
		const result = classifyTurn(turn);
		expect(result).toBeDefined();
		expect(result!.eventType).toBe("gotcha_discovered");
		expect(result!.payload).toContain("failed:");
	});

	it("returns gotcha_discovered for build failure", () => {
		const turn = freshTurn();
		turn.bashCommands = [
			{
				command: "npm run check",
				exitCode: 1,
				outputSnippet: "error TS2345: Argument of type 'string'",
				isError: true,
			},
		];
		turn.toolCallCount = 1;
		const result = classifyTurn(turn);
		expect(result).toBeDefined();
		expect(result!.eventType).toBe("gotcha_discovered");
	});

	it("includes file context in gotcha_discovered when files were edited", () => {
		const turn = freshTurn();
		turn.files = [{ path: "src/broken.ts", action: "edit" }];
		turn.bashCommands = [
			{
				command: "npx vitest --run test/broken.test.ts",
				exitCode: 1,
				outputSnippet: "AssertionError: expected 1 to be 2",
				isError: true,
			},
		];
		turn.toolCallCount = 2;
		const result = classifyTurn(turn);
		expect(result!.eventType).toBe("gotcha_discovered");
		expect(result!.payload).toContain("while editing: src/broken.ts");
	});

	it("gotcha takes priority over task_completed when tests fail", () => {
		const turn = freshTurn();
		turn.files = [
			{ path: "src/a.ts", action: "edit" },
			{ path: "src/b.ts", action: "edit" },
		];
		turn.bashCommands = [
			{ command: "npm run test", exitCode: 1, outputSnippet: "1 failed", isError: true },
		];
		turn.toolCallCount = 3;
		const result = classifyTurn(turn);
		expect(result!.eventType).toBe("gotcha_discovered");
	});

	// -- error_pattern --

	it("returns error_pattern for tool errors with file mutations", () => {
		const turn = freshTurn();
		turn.files = [{ path: "src/index.ts", action: "edit" }];
		turn.toolErrors = ["edit: no unique match for oldText"];
		turn.toolCallCount = 2;
		const result = classifyTurn(turn);
		expect(result).toBeDefined();
		expect(result!.eventType).toBe("error_pattern");
		expect(result!.payload).toContain("1 tool error(s)");
		expect(result!.payload).toContain("src/index.ts");
	});

	it("returns undefined for tool errors without file mutations", () => {
		const turn = freshTurn();
		turn.toolErrors = ["read: file not found"];
		turn.toolCallCount = 1;
		expect(classifyTurn(turn)).toBeUndefined();
	});

	// -- vitest/jest/pytest variants --

	it("detects vitest test runs", () => {
		const turn = freshTurn();
		turn.files = [{ path: "test/foo.test.ts", action: "write" }];
		turn.bashCommands = [
			{ command: "npx vitest --run test/foo.test.ts", exitCode: 0, outputSnippet: "1 passed", isError: false },
		];
		turn.toolCallCount = 2;
		const result = classifyTurn(turn);
		expect(result!.eventType).toBe("task_completed");
		expect(result!.payload).toContain("tests passed");
	});

	it("detects pytest runs", () => {
		const turn = freshTurn();
		turn.files = [{ path: "src/main.py", action: "edit" }];
		turn.bashCommands = [
			{ command: "pytest tests/", exitCode: 0, outputSnippet: "5 passed", isError: false },
		];
		turn.toolCallCount = 2;
		const result = classifyTurn(turn);
		expect(result!.eventType).toBe("task_completed");
		expect(result!.payload).toContain("tests passed");
	});

	it("detects cargo test runs", () => {
		const turn = freshTurn();
		turn.files = [{ path: "src/lib.rs", action: "edit" }];
		turn.bashCommands = [
			{ command: "cargo test", exitCode: 1, outputSnippet: "test foo ... FAILED", isError: true },
		];
		turn.toolCallCount = 2;
		const result = classifyTurn(turn);
		expect(result!.eventType).toBe("gotcha_discovered");
	});

	it("detects eslint and biome as build/lint", () => {
		const turn = freshTurn();
		turn.files = [{ path: "src/a.ts", action: "edit" }];
		turn.bashCommands = [
			{ command: "npx eslint src/", exitCode: 0, outputSnippet: "", isError: false },
		];
		turn.toolCallCount = 2;
		const result = classifyTurn(turn);
		expect(result!.eventType).toBe("task_completed");
		expect(result!.payload).toContain("build/lint clean");
	});
});

// ---------------------------------------------------------------------------
// formatFiles
// ---------------------------------------------------------------------------

describe("formatFiles", () => {
	it("returns single file", () => {
		expect(formatFiles([{ path: "a.ts", action: "edit" }])).toBe("a.ts");
	});

	it("returns multiple files", () => {
		const files = [
			{ path: "a.ts", action: "edit" as const },
			{ path: "b.ts", action: "write" as const },
			{ path: "c.ts", action: "edit" as const },
		];
		expect(formatFiles(files)).toBe("a.ts, b.ts, c.ts");
	});

	it("truncates with +N more for > 3 files", () => {
		const files = [
			{ path: "a.ts", action: "edit" as const },
			{ path: "b.ts", action: "edit" as const },
			{ path: "c.ts", action: "edit" as const },
			{ path: "d.ts", action: "edit" as const },
			{ path: "e.ts", action: "edit" as const },
		];
		expect(formatFiles(files)).toBe("a.ts, b.ts, c.ts +2 more");
	});

	it("deduplicates same file edited multiple times", () => {
		const files = [
			{ path: "a.ts", action: "edit" as const },
			{ path: "a.ts", action: "edit" as const },
			{ path: "b.ts", action: "write" as const },
		];
		expect(formatFiles(files)).toBe("a.ts, b.ts");
	});
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe("truncate", () => {
	it("returns short strings unchanged", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});

	it("truncates long strings with ellipsis", () => {
		expect(truncate("hello world", 8)).toBe("hello w…");
	});

	it("collapses newlines", () => {
		expect(truncate("line1\nline2\nline3", 50)).toBe("line1 line2 line3");
	});

	it("trims whitespace", () => {
		expect(truncate("  hello  ", 10)).toBe("hello");
	});
});

// ---------------------------------------------------------------------------
// extractOutputSnippet
// ---------------------------------------------------------------------------

describe("extractOutputSnippet", () => {
	it("returns empty for no text content", () => {
		expect(extractOutputSnippet([])).toBe("");
	});

	it("extracts text from content array", () => {
		const content = [{ type: "text", text: "line1\nline2\nline3" }];
		expect(extractOutputSnippet(content)).toBe("line1\nline2\nline3");
	});

	it("returns last 5 non-empty lines", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
		const content = [{ type: "text", text: lines }];
		expect(extractOutputSnippet(content)).toBe("line6\nline7\nline8\nline9\nline10");
	});

	it("skips empty lines", () => {
		const content = [{ type: "text", text: "a\n\n\nb\n\nc" }];
		expect(extractOutputSnippet(content)).toBe("a\nb\nc");
	});

	it("ignores non-text content", () => {
		const content = [
			{ type: "image" },
			{ type: "text", text: "hello" },
		];
		expect(extractOutputSnippet(content)).toBe("hello");
	});
});

// ---------------------------------------------------------------------------
// parseJsonFromOutput
// ---------------------------------------------------------------------------

describe("parseJsonFromOutput", () => {
	it("returns undefined for empty string", () => {
		expect(parseJsonFromOutput("")).toBeUndefined();
	});

	it("parses clean JSON", () => {
		const result = parseJsonFromOutput('{"key": "value"}');
		expect(result).toEqual({ key: "value" });
	});

	it("parses JSON with leading text", () => {
		const result = parseJsonFromOutput('Registered as: golden-hyena\n{"session_id": "abc"}');
		expect(result).toEqual({ session_id: "abc" });
	});

	it("parses JSON array", () => {
		const result = parseJsonFromOutput('[1, 2, 3]');
		expect(result).toEqual([1, 2, 3]);
	});

	it("returns undefined for non-JSON text", () => {
		expect(parseJsonFromOutput("hello world")).toBeUndefined();
	});

	it("returns undefined for invalid JSON after brace", () => {
		expect(parseJsonFromOutput("{broken json")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// freshTurn
// ---------------------------------------------------------------------------

describe("freshTurn", () => {
	it("returns empty turn activity", () => {
		const turn = freshTurn();
		expect(turn.files).toEqual([]);
		expect(turn.bashCommands).toEqual([]);
		expect(turn.toolErrors).toEqual([]);
		expect(turn.toolCallCount).toBe(0);
	});

	it("returns independent instances", () => {
		const a = freshTurn();
		const b = freshTurn();
		a.files.push({ path: "x", action: "write" });
		expect(b.files).toEqual([]);
	});
});
