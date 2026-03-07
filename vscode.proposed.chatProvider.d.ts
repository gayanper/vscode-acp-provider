/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// version: 4

declare module 'vscode' {

	export interface LanguageModelChatInformation {

		/**
		 * When present, this gates the use of `requestLanguageModelAccess` behind an authorization flow where
		 * the user must approve of another extension accessing the models contributed by this extension.
		 * Additionally, the extension can provide a label that will be shown in the UI.
		 */
		requiresAuthorization?: true | { label: string };

		/**
		 * A multiplier indicating how many requests this model counts towards a quota.
		 * For example, "2x" means each request counts twice.
		 */
		readonly multiplier?: string;

		/**
		 * A numeric form of the `multiplier` label
		 */
		readonly multiplierNumeric?: number;

		/**
		 * Whether or not this will be selected by default in the model picker.
		 * NOT BEING FINALIZED
		 */
		readonly isDefault?: boolean | { [K in ChatLocation]?: boolean };

		/**
		 * Whether or not the model will show up in the model picker immediately upon being made known via
		 * {@linkcode LanguageModelChatProvider.provideLanguageModelChatInformation}.
		 * NOT BEING FINALIZED
		 */
		readonly isUserSelectable?: boolean;

		/**
		 * Optional category to group models by in the model picker.
		 * The lower the order, the higher the category appears in the list.
		 * Has no effect if `isUserSelectable` is `false`.
		 *
		 * WONT BE FINALIZED
		 */
		readonly category?: { label: string; order: number };

		readonly statusIcon?: ThemeIcon;

		/**
		 * When set, this model is only shown in the model picker for the specified chat session type.
		 * Models with this property are excluded from the general model picker and only appear
		 * when the user is in a session matching this type.
		 *
		 * The value must match a `type` declared in a `chatSessions` extension contribution.
		 */
		readonly targetChatSessionType?: string;
	}

	export interface LanguageModelChatCapabilities {

		/**
		 * The tools the model prefers for making file edits.
		 * Edit tools currently recognized include: 'find-replace', 'multi-find-replace', 'apply-patch', 'code-rewrite'
		 */
		readonly editTools?: string[];
	}
}
