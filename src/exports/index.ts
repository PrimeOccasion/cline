import * as vscode from "vscode"
import { ClineProvider } from "../core/webview/ClineProvider"
import { ClineAPI } from "./cline"

export function createClineAPI(outputChannel: vscode.OutputChannel, fallbackProvider: ClineProvider): ClineAPI {
	// Helper function to get the active provider or fall back to the sidebar provider
	const getActiveProvider = (): ClineProvider => {
		return ClineProvider.getVisibleInstance() || fallbackProvider
	}

	const api: ClineAPI = {
		setCustomInstructions: async (value: string) => {
			const provider = getActiveProvider()
			await provider.updateCustomInstructions(value)
			outputChannel.appendLine("Custom instructions set")
		},

		getCustomInstructions: async () => {
			const provider = getActiveProvider()
			return (await provider.getGlobalState("customInstructions")) as string | undefined
		},

		startNewTask: async (task?: string, images?: string[]) => {
			const provider = getActiveProvider()
			outputChannel.appendLine("Starting new task")
			await provider.clearTask()
			await provider.postStateToWebview()
			await provider.postMessageToWebview({
				type: "action",
				action: "chatButtonClicked",
			})
			await provider.postMessageToWebview({
				type: "invoke",
				invoke: "sendMessage",
				text: task,
				images: images,
			})
			outputChannel.appendLine(
				`Task started with message: ${task ? `"${task}"` : "undefined"} and ${images?.length || 0} image(s)`,
			)
		},

		sendMessage: async (message?: string, images?: string[]) => {
			const provider = getActiveProvider()
			outputChannel.appendLine(
				`Sending message: ${message ? `"${message}"` : "undefined"} with ${images?.length || 0} image(s)`,
			)
			await provider.postMessageToWebview({
				type: "invoke",
				invoke: "sendMessage",
				text: message,
				images: images,
			})
		},

		pressPrimaryButton: async () => {
			const provider = getActiveProvider()
			outputChannel.appendLine("Pressing primary button")
			await provider.postMessageToWebview({
				type: "invoke",
				invoke: "primaryButtonClick",
			})
		},

		pressSecondaryButton: async () => {
			const provider = getActiveProvider()
			outputChannel.appendLine("Pressing secondary button")
			await provider.postMessageToWebview({
				type: "invoke",
				invoke: "secondaryButtonClick",
			})
		},
	}

	return api
}
