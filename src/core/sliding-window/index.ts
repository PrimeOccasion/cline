/**
 * This module provides functions for LLM-based memory management.
 * It replaces the traditional sliding window approach with intelligent
 * memory management that leverages the LLM's capabilities.
 */

import { Anthropic } from "@anthropic-ai/sdk"

/**
 * No longer identifies a range to truncate, instead identifies if memory refresh is needed
 * @param messages - The conversation history
 * @param currentDeletedRange - Unused parameter kept for compatibility
 * @returns null to indicate no truncation should occur
 */
export function getNextTruncationRange(
	messages: Anthropic.MessageParam[],
	currentDeletedRange?: [number, number],
): [number, number] | undefined {
	// No truncation ranges - we're using LLM memory management instead
	return undefined
}

/**
 * Memory refresh message creator
 * @returns Memory refresh message
 */
export function createMemoryRefreshMessage(tokenCount: number, tokenLimit: number): Anthropic.MessageParam {
	const percentUsed = Math.round((tokenCount / tokenLimit) * 100)

	return {
		role: "assistant",
		content: [
			{
				type: "text",
				text: `I notice our conversation has reached ${percentUsed}% of capacity (${tokenCount.toLocaleString()} tokens).

To maintain continuity and ensure I don't lose important context, I'll now organize my understanding of what we've discussed so far...`,
			},
		],
	}
}

/**
 * Memory organization prompt creator for the LLM
 * @param messages - The conversation history
 * @returns Prompt to help LLM organize its memory
 */
export function createMemoryOrganizationPrompt(messages: Anthropic.MessageParam[]): string {
	const currentTask = extractCurrentTask(messages)

	return `As an AI assistant, I need to organize my memory of our conversation to maintain perfect continuity.

CURRENT TASK: ${currentTask}

Please help me create a comprehensive memory structure that includes:

1. The exact details of my current task and its requirements
2. Important code files, paths, and implementation details we've discussed
3. Key technical decisions and their rationales
4. System architecture and design patterns relevant to our work
5. Progress so far and immediate next steps

Format this as a structured, organized memory overview that I can reference to maintain complete awareness of our conversation context. Focus especially on preserving precise technical details like file paths, function names, and code structures.`
}

/**
 * Extract the current task from conversation history
 * @param messages - The conversation history
 * @returns The extracted current task description
 */
export function extractCurrentTask(messages: Anthropic.MessageParam[]): string {
	// Check recent messages first (last 10 messages)
	const recentRange = Math.min(messages.length, 10)
	for (let i = messages.length - 1; i >= messages.length - recentRange; i--) {
		const message = messages[i]
		if (message.role === "user") {
			const content = extractTextContent(message)
			if (content && isTaskDefinition(content)) {
				return content
			}
		}
	}

	// If no recent task found, check the first few messages
	for (let i = 0; i < Math.min(5, messages.length); i++) {
		const message = messages[i]
		if (message.role === "user") {
			const content = extractTextContent(message)
			if (content) {
				return content
			}
		}
	}

	return "Ongoing technical discussion"
}

/**
 * Extract text content from a message
 */
function extractTextContent(message: Anthropic.MessageParam): string | undefined {
	if (Array.isArray(message.content)) {
		const textBlock = message.content.find((block) => block.type === "text")
		return textBlock ? textBlock.text : undefined
	}

	return typeof message.content === "string" ? message.content : undefined
}

/**
 * Determine if text is likely defining a task
 */
function isTaskDefinition(content: string): boolean {
	const taskPatterns = [
		/^(?:can you|could you|please|i want|i need|help me)/i,
		/^(?:let'?s|we should|we need to)/i,
		/^(?:actually|instead|but now|switching)/i,
		/(task|goal|objective)s?:/i,
		/\?$/, // Questions often define new tasks
	]

	return taskPatterns.some((pattern) => pattern.test(content.trim()))
}

/**
 * No longer truncates messages, instead appends memory structure messages
 * @param messages - The full conversation history
 * @param deletedRange - Unused parameter kept for compatibility
 * @param memoryStructure - Optional memory structure to add
 * @returns Original messages with memory structure appended
 */
export function getTruncatedMessages(
	messages: Anthropic.MessageParam[],
	deletedRange?: [number, number],
	memoryStructure?: Anthropic.MessageParam,
): Anthropic.MessageParam[] {
	// No truncation - if we have a memory structure, append it
	if (memoryStructure) {
		return [...messages, memoryStructure]
	}

	// Otherwise return the original messages unchanged
	return messages
}
