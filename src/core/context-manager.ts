import { Anthropic } from "@anthropic-ai/sdk"
import { ApiHandler } from "../api"
import * as SlidingWindow from "./sliding-window"

// Interface for context analysis results
interface ContextAnalysis {
	totalTokens: number
	utilizationPercentage: number
	needsSummarization: boolean
	messageCount: number
}

// Interface for optimization results
interface OptimizationResult {
	history: Anthropic.MessageParam[]
	deletedRange: [number, number] | undefined
	didSummarize: boolean
	messagesReplaced?: number
	tokensBefore?: number
	tokensAfter?: number
	summaryBrief?: string
}

// Define memory refresh strategies
type MemoryStrategy = "light" | "standard" | "aggressive" | "emergency"

/**
 * Context management using LLM-based memory rather than truncation
 */
export class ContextManager {
	private model: string
	private maxContextLength: number
	private memoryThreshold: number
	private emergencyThreshold: number
	private lastMemoryRefreshTokenCount: number = 0
	private memoryRefreshCount: number = 0

	constructor(model: string, maxContextLength: number) {
		this.model = model
		this.maxContextLength = maxContextLength || 128000

		// Set thresholds for memory refresh
		this.memoryThreshold = 0.6 // Standard threshold at 60%
		this.emergencyThreshold = 0.8 // Emergency threshold at 80%
	}

	/**
	 * Estimates token count for a message
	 */
	private estimateTokenCount(message: Anthropic.MessageParam): number {
		let tokenCount = 0

		if (Array.isArray(message.content)) {
			tokenCount = message.content.reduce((sum, block) => {
				if (block.type === "text") {
					// More accurate token estimation for text
					const text = block.text
					const words = text.split(/\s+/).length
					const punctuation = (text.match(/[.,!?;:()[\]{}'"]/g) || []).length
					return sum + words + Math.ceil(punctuation * 0.5)
				} else if (block.type === "tool_use") {
					// Overhead + parameter lengths
					const paramLength = JSON.stringify(block.input || {}).length / 4
					return sum + 20 + paramLength // Base overhead + param
				} else if (block.type === "tool_result") {
					// Estimate based on result content length
					const resultLength =
						typeof block.content === "string" ? block.content.length : JSON.stringify(block.content).length
					return sum + 10 + resultLength / 4 // Overhead + content
				}
				return sum + 10 // Default overhead for unknown block
			}, 0)
		} else if (typeof message.content === "string") {
			// Simple text
			tokenCount = message.content.length / 4
		}

		// Add role overhead
		tokenCount += 4

		// Apply correction factor
		return Math.ceil(tokenCount * 1.8)
	}

	/**
	 * Analyzes conversation to determine if memory refresh is needed
	 */
	public analyzeConversation(messages: Anthropic.MessageParam[]): ContextAnalysis {
		let totalTokens = 0

		// Calculate token usage for all messages
		messages.forEach((message) => {
			totalTokens += this.estimateTokenCount(message)
		})

		const utilizationPercentage = totalTokens / this.maxContextLength

		// Memory refresh needed?
		let needsSummarization = false

		// Add a hard token limit
		const hardTokenLimit = 60000 // About half of typical context window

		// Force summarization if we exceed the hard token limit
		if (totalTokens > hardTokenLimit) {
			needsSummarization = true
		}
		// If this is the first refresh, use the standard threshold
		else if (this.memoryRefreshCount === 0) {
			needsSummarization = utilizationPercentage >= this.memoryThreshold
		}
		// For subsequent refreshes, check token growth since last refresh
		else {
			const tokenGrowth = totalTokens - this.lastMemoryRefreshTokenCount
			const growthPercentage = tokenGrowth / this.maxContextLength

			// Only refresh if we've grown by at least 15% since last refresh
			// OR if we're in emergency territory
			needsSummarization =
				(growthPercentage >= 0.15 && utilizationPercentage >= this.memoryThreshold) ||
				utilizationPercentage >= this.emergencyThreshold
		}

		// Log detailed analysis
		console.log(
			`[ContextManager] Analysis: ${Math.round(utilizationPercentage * 100)}% used, ${totalTokens}/${this.maxContextLength} tokens`,
		)
		console.log(
			`[ContextManager] Last memory refresh at: ${this.lastMemoryRefreshTokenCount} tokens, count: ${this.memoryRefreshCount}`,
		)
		console.log(
			`[ContextManager] Need memory refresh: ${needsSummarization}, threshold: ${Math.round(this.memoryThreshold * 100)}%`,
		)

		return {
			totalTokens,
			utilizationPercentage,
			needsSummarization,
			messageCount: messages.length,
		}
	}

	/**
	 * Determines the appropriate memory strategy based on token utilization
	 */
	private getMemoryStrategy(utilization: number): MemoryStrategy {
		if (utilization >= this.emergencyThreshold) return "emergency"
		if (utilization >= this.memoryThreshold + 0.15) return "aggressive"
		if (utilization >= this.memoryThreshold) return "standard"
		return "light"
	}

	/**
	 * Creates a brief conversation summary for memory decision making
	 */
	private createBriefConversationSummary(messages: Anthropic.MessageParam[]): string {
		// Create a very brief summary of the conversation to help the LLM understand the context
		// This is just for the decision-making process, not the actual memory structure

		const taskMessage = messages.find(
			(msg) =>
				msg.role === "user" &&
				(Array.isArray(msg.content)
					? msg.content.some((block) => block.type === "text" && block.text.includes("<task>"))
					: typeof msg.content === "string" && msg.content.includes("<task>")),
		)

		const taskDescription = taskMessage
			? "Task: " +
				(Array.isArray(taskMessage.content)
					? taskMessage.content.find((block) => block.type === "text")?.text.replace(/<\/?task>/g, "") || "Unknown"
					: taskMessage.content.replace(/<\/?task>/g, ""))
			: "No explicit task found"

		const messageCount = messages.length
		const userMessages = messages.filter((msg) => msg.role === "user").length
		const assistantMessages = messages.filter((msg) => msg.role === "assistant").length

		return `${taskDescription}
Total messages: ${messageCount} (${userMessages} user, ${assistantMessages} assistant)
Conversation spans from message 0 to ${messageCount - 1}`
	}

	/**
	 * Creates a memory decision prompt for the LLM
	 */
	private createMemoryDecisionPrompt(messages: Anthropic.MessageParam[], strategy: MemoryStrategy): string {
		const totalMessages = messages.length

		// Calculate token statistics instead of listing every message
		const totalTokens = messages.reduce((sum, msg) => sum + this.estimateTokenCount(msg), 0)
		const avgTokens = Math.round(totalTokens / totalMessages)

		// Find largest messages (top 5)
		const largestMessages = messages
			.map((msg, i) => ({ index: i, tokens: this.estimateTokenCount(msg) }))
			.sort((a, b) => b.tokens - a.tokens)
			.slice(0, 5)
			.map((item) => `Message ${item.index}: ${item.tokens} tokens`)

		let strategyInstructions = ""
		switch (strategy) {
			case "emergency":
				strategyInstructions =
					"EMERGENCY context situation. Be extremely aggressive in summarization. Keep only the most recent and critical messages."
				break
			case "aggressive":
				strategyInstructions = "Token usage is high. Be aggressive in summarization while preserving key context."
				break
			case "standard":
				strategyInstructions =
					"Create a balanced memory structure that preserves important context while reducing token usage."
				break
			case "light":
				strategyInstructions = "Light optimization needed. Focus on summarizing older, less relevant messages."
				break
		}

		return `You are managing the memory of an ongoing technical conversation with ${totalMessages} messages.

${strategyInstructions}

CONVERSATION SUMMARY:
${this.createBriefConversationSummary(messages)}

TOKEN STATISTICS:
- Total tokens: ${totalTokens}
- Average per message: ${avgTokens}
- Largest messages:
${largestMessages.join("\n")}

Your task is to decide which messages should be kept verbatim and which should be summarized to optimize memory usage.

Please analyze the conversation and provide:
1. INDICES_TO_KEEP: A JSON array of message indices that should be kept verbatim (e.g., [10, 11, 12, 15, 16, 17, 18, 19])
2. SUMMARY_INSTRUCTIONS: Specific instructions for how to summarize the removed messages

Guidelines:
- Always keep the most recent messages (recency is important)
- Preserve messages containing critical decisions, code snippets, or technical details
- Consider summarizing explanations, discussions, and context-setting messages
- Balance token reduction with context preservation

Respond in this exact format:
INDICES_TO_KEEP: [array of indices]
SUMMARY_INSTRUCTIONS: Your specific instructions for summarization`
	}

	/**
	 * Parses the memory decision from the LLM
	 */
	private parseMemoryDecision(decisionText: string): {
		messagesToKeepIndices: number[]
		summaryInstructions: string
	} {
		// Default values in case parsing fails
		let messagesToKeepIndices: number[] = []
		let summaryInstructions = "Create a comprehensive summary of the removed messages."

		try {
			// Extract indices to keep
			const indicesMatch = decisionText.match(/INDICES_TO_KEEP:\s*(\[[\d,\s]*\])/i)
			if (indicesMatch && indicesMatch[1]) {
				messagesToKeepIndices = JSON.parse(indicesMatch[1])
			}

			// Extract summary instructions
			const instructionsMatch = decisionText.match(/SUMMARY_INSTRUCTIONS:\s*([\s\S]*?)(?:$|INDICES_TO_KEEP)/i)
			if (instructionsMatch && instructionsMatch[1]) {
				summaryInstructions = instructionsMatch[1].trim()
			}
		} catch (error) {
			console.error("Failed to parse memory decision:", error)
			// Fall back to keeping the most recent 10 messages
			const totalMessages = 10
			messagesToKeepIndices = Array.from({ length: totalMessages }, (_, i) => i)
		}

		return { messagesToKeepIndices, summaryInstructions }
	}

	/**
	 * Summarizes a long message using an additional LLM call
	 */
	private async summarizeLongMessage(api: ApiHandler, message: string): Promise<string> {
		const prompt = `Summarize this long technical message while preserving all:
1) Code snippets (exact syntax)
2) File paths and technical identifiers
3) Command examples
4) Key technical decisions

Your summary should be about 30-40% of the original length while maintaining all critical technical information.

MESSAGE:
${message}`

		const stream = api.createMessage("You are an AI assistant summarizing a technical message.", [
			{ role: "user", content: [{ type: "text", text: prompt }] },
		])

		let summary = ""
		for await (const chunk of stream) {
			if (chunk.type === "text") {
				summary += chunk.text
			}
		}

		return `[SUMMARIZED LONG MESSAGE: ${summary}]`
	}

	/**
	 * Creates a memory structure prompt for the LLM
	 */
	private async createMemoryStructurePrompt(
		api: ApiHandler,
		messagesToSummarize: Anthropic.MessageParam[],
		summaryInstructions: string,
	): Promise<string> {
		// Process messages - summarize very long messages with an LLM call instead of truncating
		const MAX_TEXT_LENGTH = 1000 // Threshold for long text blocks
		const conversationContent = await Promise.all(
			messagesToSummarize.map(async (msg, i) => {
				const role = msg.role.toUpperCase()
				let content = ""

				if (Array.isArray(msg.content)) {
					const contentBlocks = await Promise.all(
						msg.content.map(async (block) => {
							if (block.type === "text") {
								const text = block.text
								// Use LLM to summarize very long text blocks instead of truncating
								if (text.length > MAX_TEXT_LENGTH) {
									return await this.summarizeLongMessage(api, text)
								}
								return text
							} else if (block.type === "tool_use") {
								return `[TOOL: ${(block as any).name || "unknown"} with parameters]`
							} else if (block.type === "tool_result") {
								return `[TOOL RESULT: ${(block as any).tool_use_id || "unknown"}]`
							}
							return `[${block.type} content]`
						}),
					)
					content = contentBlocks.join("\n")
				} else if (typeof msg.content === "string") {
					// Use LLM to summarize very long string content
					if (msg.content.length > MAX_TEXT_LENGTH) {
						content = await this.summarizeLongMessage(api, msg.content)
					} else {
						content = msg.content
					}
				}

				return `MESSAGE ${i} (${role}):\n${content}\n`
			}),
		)

		const formattedContent = conversationContent.join("\n---\n")

		return `You are creating a memory structure to replace ${messagesToSummarize.length} messages in an ongoing technical conversation.

SUMMARY INSTRUCTIONS:
${summaryInstructions}

MESSAGES TO SUMMARIZE:
${conversationContent}

Create a structured memory summary that:
1. Preserves critical information: code snippets, file paths, technical decisions, and key context
2. Uses a concise, hierarchical format with clear sections
3. Prioritizes technical details over general discussion
4. Omits redundant information and pleasantries
5. Is optimized for token efficiency while maintaining all essential context

Your summary will replace these messages in the conversation history, so it must maintain perfect continuity.`
	}

	/**
	 * Optimize conversation history using LLM memory management
	 * This implementation actually replaces messages with a summary instead of just appending
	 */
	public async optimizeConversationHistory(
		api: ApiHandler,
		history: Anthropic.MessageParam[],
		deletedRange: [number, number] | undefined,
	): Promise<OptimizationResult> {
		// Analyze conversation to determine if memory refresh is needed
		const analysis = this.analyzeConversation(history)
		console.log(
			`[ContextManager] Starting memory optimization with ${history.length} messages, utilization: ${Math.round(analysis.utilizationPercentage * 100)}%`,
		)

		// If memory refresh not needed, return unchanged
		if (!analysis.needsSummarization) {
			console.log(`[ContextManager] Memory refresh not needed, skipping`)
			return {
				history,
				deletedRange: undefined,
				didSummarize: false,
			}
		}

		// Determine memory strategy based on current token usage
		const strategy = this.getMemoryStrategy(analysis.utilizationPercentage)
		console.log(`[ContextManager] Using ${strategy} memory strategy for ${analysis.totalTokens} tokens`)

		// STEP 1: Ask the LLM to decide which messages to keep and which to summarize
		console.log(`[ContextManager] Requesting memory decision from LLM`)
		const memoryDecisionPrompt = this.createMemoryDecisionPrompt(history, strategy)
		const memoryDecisionStream = api.createMessage(
			"You are an AI assistant organizing your memory of a technical conversation.",
			[{ role: "user", content: [{ type: "text", text: memoryDecisionPrompt }] }],
		)

		// Collect memory decision from stream
		let memoryDecisionText = ""
		for await (const chunk of memoryDecisionStream) {
			if (chunk.type === "text") {
				memoryDecisionText += chunk.text
			}
		}

		// Parse the decision to get indices of messages to keep
		const { messagesToKeepIndices, summaryInstructions } = this.parseMemoryDecision(memoryDecisionText)

		// STEP 2: Create memory structure based on the LLM's decision
		const messagesToSummarize = history.filter((_, index) => !messagesToKeepIndices.includes(index))

		// Now pass the API to the createMemoryStructurePrompt method
		console.log(`[ContextManager] Requesting memory structure from LLM for ${messagesToSummarize.length} messages`)
		const memoryStructurePrompt = await this.createMemoryStructurePrompt(api, messagesToSummarize, summaryInstructions)

		const memoryStructureStream = api.createMessage(
			"You are an AI assistant organizing your memory of a technical conversation.",
			[{ role: "user", content: [{ type: "text", text: memoryStructurePrompt }] }],
		)

		// Collect memory structure from stream
		let memoryStructureText = ""
		for await (const chunk of memoryStructureStream) {
			if (chunk.type === "text") {
				memoryStructureText += chunk.text
			}
		}

		// Create memory structure message
		const memoryStructureMessage: Anthropic.MessageParam = {
			role: "assistant",
			content: [{ type: "text", text: memoryStructureText }],
		}

		// STEP 3: Replace old messages with the memory structure
		const messagesToKeep = history.filter((_, index) => messagesToKeepIndices.includes(index))

		// Create new history with memory structure at the beginning followed by kept messages
		const newHistory = [memoryStructureMessage, ...messagesToKeep]

		// Calculate the deleted range based on which messages were removed
		const newDeletedRange: [number, number] = [0, history.length - messagesToKeep.length]

		// Update memory refresh tracking
		this.lastMemoryRefreshTokenCount = newHistory.reduce((sum, msg) => sum + this.estimateTokenCount(msg), 0)
		this.memoryRefreshCount++

		// Extract a brief summary (first 5 words)
		const summaryBrief = memoryStructureText.split(" ").slice(0, 5).join(" ") + "..."

		console.log(
			`[ContextManager] Memory refresh #${this.memoryRefreshCount} complete. Replaced ${messagesToSummarize.length} messages with a summary. New history has ${newHistory.length} messages. Token count: ${this.lastMemoryRefreshTokenCount}`,
		)

		return {
			history: newHistory,
			deletedRange: newDeletedRange,
			didSummarize: true,
			messagesReplaced: messagesToSummarize.length,
			tokensBefore: analysis.totalTokens,
			tokensAfter: this.lastMemoryRefreshTokenCount,
			summaryBrief,
		}
	}

	/**
	 * Legacy method for creating memory structure
	 * Kept for backward compatibility
	 */
	public async createMemoryStructure(
		api: ApiHandler,
		messages: Anthropic.MessageParam[],
		strategy: MemoryStrategy,
	): Promise<string> {
		try {
			// Generate prompt for memory organization based on strategy
			const prompt = SlidingWindow.createMemoryOrganizationPrompt(messages)

			// Add strategy-specific instructions
			let strategyInstructions = ""
			switch (strategy) {
				case "emergency":
					strategyInstructions =
						"This is an EMERGENCY context situation (very high token usage). Create an extremely focused and concise memory structure."
					break
				case "aggressive":
					strategyInstructions =
						"Token usage is high. Create a focused memory structure that prioritizes the most important information."
					break
				case "standard":
					strategyInstructions = "Create a balanced memory structure that organizes key information efficiently."
					break
				case "light":
					strategyInstructions = "Create a comprehensive memory structure that organizes all important details."
					break
			}

			// Create memory structure request
			const fullPrompt = `${strategyInstructions}\n\n${prompt}`

			// Call the API to create the memory structure
			const stream = api.createMessage("You are an AI assistant organizing your memory of a technical conversation.", [
				{
					role: "user",
					content: [{ type: "text", text: fullPrompt }],
				},
			])

			// Collect memory structure from stream
			let memoryStructure = ""
			for await (const chunk of stream) {
				if (chunk.type === "text") {
					memoryStructure += chunk.text
				}
			}

			return memoryStructure
		} catch (error) {
			console.error("Failed to create memory structure:", error)

			// Fallback memory structure
			return `# MEMORY STRUCTURE

## CURRENT TASK
I'm continuing to help with the current task, focusing on maintaining context in our conversation.

## CODE CONTEXT
I'm maintaining awareness of the code files, paths, and implementation details we've discussed.

## TECHNICAL DECISIONS
I remember our key technical decisions and their rationales.

## NEXT STEPS
I'll continue helping with the implementation as we discussed.`
		}
	}
}
