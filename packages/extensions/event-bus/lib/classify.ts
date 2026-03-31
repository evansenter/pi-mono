/**
 * Pure logic for turn activity classification and helpers.
 * Extracted for testability — no side effects, no pi/CLI dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileActivity {
	path: string;
	action: "write" | "edit";
}

export interface BashActivity {
	command: string;
	exitCode: number;
	outputSnippet: string;
	isError: boolean;
}

export interface TurnActivity {
	files: FileActivity[];
	bashCommands: BashActivity[];
	toolErrors: string[];
	toolCallCount: number;
}

export interface ClassifiedEvent {
	eventType: string;
	payload: string;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function classifyTurn(turn: TurnActivity): ClassifiedEvent | undefined {
	const { files, bashCommands, toolErrors, toolCallCount } = turn;

	const hasMutations = files.length > 0;
	const hasErrors = toolErrors.length > 0;
	const hasTestRun = bashCommands.some((b) =>
		/\b(test|spec|jest|vitest|pytest|cargo test|go test|npm run test|npx .*(vitest|jest))\b/i.test(b.command),
	);
	const hasTestFailure = bashCommands.some((b) =>
		/\b(test|spec|jest|vitest|pytest|cargo test|go test)\b/i.test(b.command) && b.isError,
	);
	const hasBuildOrLint = bashCommands.some((b) =>
		/\b(build|check|lint|tsc|eslint|biome|prettier)\b/i.test(b.command),
	);
	const hasBuildFailure = bashCommands.some((b) =>
		/\b(build|check|lint|tsc|eslint|biome|prettier)\b/i.test(b.command) && b.isError,
	);

	// Gotcha: test or build failure.
	if (hasTestFailure || hasBuildFailure) {
		const failedCmds = bashCommands.filter((b) => b.isError).map((b) => truncate(b.command, 60));
		const errorSnippets = bashCommands
			.filter((b) => b.isError && b.outputSnippet)
			.map((b) => truncate(b.outputSnippet, 120));
		const parts = [`failed: ${failedCmds.join(", ")}`, ...errorSnippets];
		if (files.length > 0) {
			parts.push(`while editing: ${formatFiles(files)}`);
		}
		return { eventType: "gotcha_discovered", payload: parts.join(" | ") };
	}

	// Tool errors with file mutations.
	if (hasErrors && hasMutations) {
		return {
			eventType: "error_pattern",
			payload: `${toolErrors.length} tool error(s) while editing ${formatFiles(files)}: ${toolErrors.map((e) => truncate(e, 80)).join("; ")}`,
		};
	}

	// Substantial work.
	if (hasMutations && (files.length >= 2 || hasTestRun || hasBuildOrLint || toolCallCount >= 5)) {
		const parts = [`edited ${formatFiles(files)}`];
		if (hasTestRun && !hasTestFailure) parts.push("tests passed");
		if (hasBuildOrLint && !hasBuildFailure) parts.push("build/lint clean");
		return { eventType: "task_completed", payload: parts.join(", ") };
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatFiles(files: FileActivity[]): string {
	const unique = [...new Set(files.map((f) => f.path))];
	if (unique.length <= 3) return unique.join(", ");
	return `${unique.slice(0, 3).join(", ")} +${unique.length - 3} more`;
}

export function truncate(s: string, max: number): string {
	const oneLine = s.replace(/\n/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function extractOutputSnippet(content: Array<{ type: string; text?: string }>): string {
	const text = content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text!)
		.join("\n");
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	return lines.slice(-5).join("\n");
}

export function parseJsonFromOutput(stdout: string): Record<string, unknown> | undefined {
	const text = stdout.trim();
	if (!text) return undefined;
	const jsonStart = text.search(/[{[]/);
	if (jsonStart === -1) return undefined;
	try {
		return JSON.parse(text.slice(jsonStart));
	} catch {
		return undefined;
	}
}

export function freshTurn(): TurnActivity {
	return { files: [], bashCommands: [], toolErrors: [], toolCallCount: 0 };
}
