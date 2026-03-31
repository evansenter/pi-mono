import { describe, expect, it } from "vitest";
import {
	classifyTurn,
	classifyEventPriority,
	extractOutputSnippet,
	formatEventForAgent,
	formatFiles,
	freshTurn,
	isEventStale,
	buildBatchMessage,
	parseJsonFromOutput,
	truncate,
	type TurnActivity,
	type BusEvent,
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

// ---------------------------------------------------------------------------
// classifyEventPriority
// ---------------------------------------------------------------------------

describe("classifyEventPriority", () => {
	it("returns immediate for DM regardless of event type", () => {
		expect(classifyEventPriority("task_completed", true)).toBe("immediate");
	});
	it("returns immediate for help_needed", () => {
		expect(classifyEventPriority("help_needed", false)).toBe("immediate");
	});
	it("returns immediate for blocker", () => {
		expect(classifyEventPriority("blocker", false)).toBe("immediate");
	});
	it("returns immediate for gotcha_discovered", () => {
		expect(classifyEventPriority("gotcha_discovered", false)).toBe("immediate");
	});
	it("returns normal for task_completed", () => {
		expect(classifyEventPriority("task_completed", false)).toBe("normal");
	});
	it("returns normal for pattern_found", () => {
		expect(classifyEventPriority("pattern_found", false)).toBe("normal");
	});
	it("returns normal for improvement_suggested", () => {
		expect(classifyEventPriority("improvement_suggested", false)).toBe("normal");
	});
	it("returns normal for help_response", () => {
		expect(classifyEventPriority("help_response", false)).toBe("normal");
	});
	it("returns normal for user_broadcast", () => {
		expect(classifyEventPriority("user_broadcast", false)).toBe("normal");
	});
	it("returns ambient for unknown event types", () => {
		expect(classifyEventPriority("session_heartbeat", false)).toBe("ambient");
	});
	it("returns ambient for error_pattern", () => {
		expect(classifyEventPriority("error_pattern", false)).toBe("ambient");
	});
});

// ---------------------------------------------------------------------------
// formatEventForAgent
// ---------------------------------------------------------------------------

describe("formatEventForAgent", () => {
	it("formats event with payload", () => {
		const event: BusEvent = {
			eventType: "help_needed", sender: "happy-tiger",
			payload: "stuck on API design", channel: "repo:dotfiles",
		};
		const result = formatEventForAgent(event);
		expect(result).toContain("[Event Bus]");
		expect(result).toContain("help_needed");
		expect(result).toContain("happy-tiger");
		expect(result).toContain("stuck on API design");
		expect(result).toContain("repo:dotfiles");
	});
	it("formats event without payload", () => {
		const event: BusEvent = {
			eventType: "task_completed", sender: "azure-gopher",
			payload: "", channel: "all",
		};
		const result = formatEventForAgent(event);
		expect(result).toContain("task_completed");
		expect(result).not.toContain("\n");
	});
	it("marks DM events", () => {
		const event: BusEvent = {
			eventType: "dm", sender: "coral-goose",
			payload: "check this out", channel: "session:abc123",
		};
		expect(formatEventForAgent(event)).toContain("[DM]");
	});
});

// ---------------------------------------------------------------------------
// isEventStale
// ---------------------------------------------------------------------------

describe("isEventStale", () => {
	it("returns true for events older than TTL", () => {
		expect(isEventStale(Date.now() - 10 * 60 * 1000, 5 * 60 * 1000)).toBe(true);
	});
	it("returns false for recent events", () => {
		expect(isEventStale(Date.now() - 60 * 1000, 5 * 60 * 1000)).toBe(false);
	});
	it("returns false when timestamp is 0 (unknown)", () => {
		expect(isEventStale(0, 5 * 60 * 1000)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// buildBatchMessage
// ---------------------------------------------------------------------------

describe("buildBatchMessage", () => {
	it("formats single event same as formatEventForAgent", () => {
		const event: BusEvent = {
			eventType: "help_needed", sender: "happy-tiger",
			payload: "need help", channel: "repo:dotfiles",
		};
		expect(buildBatchMessage([event])).toBe(formatEventForAgent(event));
	});
	it("formats multiple events with header", () => {
		const events: BusEvent[] = [
			{ eventType: "help_needed", sender: "a", payload: "help", channel: "all" },
			{ eventType: "pattern_found", sender: "b", payload: "pattern", channel: "all" },
		];
		const result = buildBatchMessage(events);
		expect(result).toContain("[Event Bus] 2 pending events:");
		expect(result).toContain("help_needed");
		expect(result).toContain("pattern_found");
	});
});
