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

		// Thresholds for memory refresh
		this.memoryThreshold = 0.7 // Start memory refresh at 70% (earlier than before)
		this.emergencyThreshold = 0.9 // Emergency mode at 90%
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

		// If this is the first refresh, use the standard threshold
		if (this.memoryRefreshCount === 0) {
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
	 * Creates a memory structure for the conversation using the LLM
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

	/**
	 * Optimize conversation history using LLM memory management instead of truncation
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
				deletedRange: undefined, // No deletion range since we don't truncate
				didSummarize: false,
			}
		}

		// Determine memory strategy based on current token usage
		const strategy = this.getMemoryStrategy(analysis.utilizationPercentage)
		console.log(`[ContextManager] Using ${strategy} memory strategy for ${analysis.totalTokens} tokens`)

		// STEP 1: Create memory refresh notification message
		const refreshMessage = SlidingWindow.createMemoryRefreshMessage(analysis.totalTokens, this.maxContextLength)
		console.log(`[ContextManager] Created memory refresh notification message`)

		// STEP 2: Create memory structure
		console.log(`[ContextManager] Requesting memory structure from LLM`)
		const memoryStructureText = await this.createMemoryStructure(api, history, strategy)

		// Create memory structure message
		const memoryStructureMessage: Anthropic.MessageParam = {
			role: "assistant",
			content: [{ type: "text", text: memoryStructureText }],
		}

		// STEP 3: Add both messages to history (NO TRUNCATION)
		const newHistory = [
			...history, // Keep all original messages
			refreshMessage, // Add refresh notification
			memoryStructureMessage, // Add memory structure
		]

		// Update memory refresh tracking
		this.lastMemoryRefreshTokenCount = newHistory.reduce((sum, msg) => sum + this.estimateTokenCount(msg), 0)
		this.memoryRefreshCount++

		console.log(
			`[ContextManager] Memory refresh #${this.memoryRefreshCount} complete. New history has ${newHistory.length} messages (added 2 messages). Token count: ${this.lastMemoryRefreshTokenCount}`,
		)

		return {
			history: newHistory,
			deletedRange: undefined, // No deletion range since we don't truncate
			didSummarize: true,
			messagesReplaced: 0, // No messages replaced, only added
		}
	}
}
