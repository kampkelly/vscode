/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { asWinJsPromise, wireCancellationToken } from 'vs/base/common/async';
import { CancellationToken } from 'vs/base/common/cancellation';
import { Emitter } from 'vs/base/common/event';
import { dispose, IDisposable } from 'vs/base/common/lifecycle';
import { TPromise } from 'vs/base/common/winjs.base';
import { ExtHostCommands } from 'vs/workbench/api/node/extHostCommands';
import { ExtHostWorkspace } from 'vs/workbench/api/node/extHostWorkspace';
import { InputBox, InputBoxOptions, QuickInput, QuickInputButton, QuickPick, QuickPickItem, QuickPickOptions, WorkspaceFolder, WorkspaceFolderPickOptions } from 'vscode';
import { ExtHostQuickOpenShape, IMainContext, MainContext, MainThreadQuickOpenShape, TransferQuickPickItems, TransferQuickInput, TransferQuickInputButton } from './extHost.protocol';
import URI from 'vs/base/common/uri';
import { ThemeIcon } from 'vs/workbench/api/node/extHostTypes';

export type Item = string | QuickPickItem;

export class ExtHostQuickOpen implements ExtHostQuickOpenShape {

	private _proxy: MainThreadQuickOpenShape;
	private _workspace: ExtHostWorkspace;
	private _commands: ExtHostCommands;

	private _onDidSelectItem: (handle: number) => void;
	private _validateInput: (input: string) => string | Thenable<string>;

	private _sessions = new Map<number, ExtHostQuickInput>();

	constructor(mainContext: IMainContext, workspace: ExtHostWorkspace, commands: ExtHostCommands) {
		this._proxy = mainContext.getProxy(MainContext.MainThreadQuickOpen);
		this._workspace = workspace;
		this._commands = commands;
	}

	showQuickPick(itemsOrItemsPromise: QuickPickItem[] | Thenable<QuickPickItem[]>, options: QuickPickOptions & { canPickMany: true; }, token?: CancellationToken): Thenable<QuickPickItem[] | undefined>;
	showQuickPick(itemsOrItemsPromise: string[] | Thenable<string[]>, options?: QuickPickOptions, token?: CancellationToken): Thenable<string | undefined>;
	showQuickPick(itemsOrItemsPromise: QuickPickItem[] | Thenable<QuickPickItem[]>, options?: QuickPickOptions, token?: CancellationToken): Thenable<QuickPickItem | undefined>;
	showQuickPick(itemsOrItemsPromise: Item[] | Thenable<Item[]>, options?: QuickPickOptions, token: CancellationToken = CancellationToken.None): Thenable<Item | Item[] | undefined> {

		// clear state from last invocation
		this._onDidSelectItem = undefined;

		const itemsPromise = <TPromise<Item[]>>TPromise.wrap(itemsOrItemsPromise);

		const quickPickWidget = this._proxy.$show({
			placeHolder: options && options.placeHolder,
			matchOnDescription: options && options.matchOnDescription,
			matchOnDetail: options && options.matchOnDetail,
			ignoreFocusLost: options && options.ignoreFocusOut,
			canPickMany: options && options.canPickMany
		});

		const promise = TPromise.any(<TPromise<number | Item[]>[]>[quickPickWidget, itemsPromise]).then(values => {
			if (values.key === '0') {
				return undefined;
			}

			return itemsPromise.then(items => {

				let pickItems: TransferQuickPickItems[] = [];
				for (let handle = 0; handle < items.length; handle++) {

					let item = items[handle];
					let label: string;
					let description: string;
					let detail: string;
					let picked: boolean;

					if (typeof item === 'string') {
						label = item;
					} else {
						label = item.label;
						description = item.description;
						detail = item.detail;
						picked = item.picked;
					}
					pickItems.push({
						label,
						description,
						handle,
						detail,
						picked
					});
				}

				// handle selection changes
				if (options && typeof options.onDidSelectItem === 'function') {
					this._onDidSelectItem = (handle) => {
						options.onDidSelectItem(items[handle]);
					};
				}

				// show items
				this._proxy.$setItems(pickItems);

				return quickPickWidget.then(handle => {
					if (typeof handle === 'number') {
						return items[handle];
					} else if (Array.isArray(handle)) {
						return handle.map(h => items[h]);
					}
					return undefined;
				});
			}, (err) => {
				this._proxy.$setError(err);

				return TPromise.wrapError(err);
			});
		});
		return wireCancellationToken<Item | Item[]>(token, promise, true);
	}

	$onItemSelected(handle: number): void {
		if (this._onDidSelectItem) {
			this._onDidSelectItem(handle);
		}
	}

	// ---- input

	showInput(options?: InputBoxOptions, token: CancellationToken = CancellationToken.None): Thenable<string> {

		// global validate fn used in callback below
		this._validateInput = options && options.validateInput;

		const promise = this._proxy.$input(options, typeof this._validateInput === 'function');
		return wireCancellationToken(token, promise, true);
	}

	$validateInput(input: string): TPromise<string> {
		if (this._validateInput) {
			return asWinJsPromise(_ => this._validateInput(input));
		}
		return undefined;
	}

	// ---- workspace folder picker

	showWorkspaceFolderPick(options?: WorkspaceFolderPickOptions, token = CancellationToken.None): Thenable<WorkspaceFolder> {
		return this._commands.executeCommand('_workbench.pickWorkspaceFolder', [options]).then((selectedFolder: WorkspaceFolder) => {
			if (!selectedFolder) {
				return undefined;
			}

			return this._workspace.getWorkspaceFolders().filter(folder => folder.uri.toString() === selectedFolder.uri.toString())[0];
		});
	}

	// ---- QuickInput

	createQuickPick(extensionId: string): QuickPick {
		const session = new ExtHostQuickPick(this._proxy, extensionId, () => this._sessions.delete(session._id));
		this._sessions.set(session._id, session);
		return session;
	}

	createInputBox(extensionId: string): InputBox {
		const session = new ExtHostInputBox(this._proxy, extensionId, () => this._sessions.delete(session._id));
		this._sessions.set(session._id, session);
		return session;
	}

	$onDidChangeValue(sessionId: number, value: string): void {
		const session = this._sessions.get(sessionId);
		if (session) {
			session._fireDidChangeValue(value);
		}
	}

	$onDidAccept(sessionId: number): void {
		const session = this._sessions.get(sessionId);
		if (session) {
			session._fireDidAccept();
		}
	}

	$onDidChangeActive(sessionId: number, handles: number[]): void {
		const session = this._sessions.get(sessionId);
		if (session instanceof ExtHostQuickPick) {
			session._fireDidChangeActive(handles);
		}
	}

	$onDidChangeSelection(sessionId: number, handles: number[]): void {
		const session = this._sessions.get(sessionId);
		if (session instanceof ExtHostQuickPick) {
			session._fireDidChangeSelection(handles);
		}
	}

	$onDidTriggerButton(sessionId: number, handle: number): void {
		const session = this._sessions.get(sessionId);
		if (session) {
			session._fireDidTriggerButton(handle);
		}
	}

	$onDidHide(sessionId: number): void {
		const session = this._sessions.get(sessionId);
		if (session) {
			session._fireDidHide();
		}
	}
}

class ExtHostQuickInput implements QuickInput {

	private static _nextId = 1;
	_id = ExtHostQuickPick._nextId++;

	private _visible = false;
	private _enabled = true;
	private _busy = false;
	private _ignoreFocusOut = true;
	private _value = '';
	private _placeholder: string;
	private _buttons: QuickInputButton[] = [];
	private _handlesToButtons = new Map<number, QuickInputButton>();
	private _onDidAcceptEmitter = new Emitter<void>();
	private _onDidChangeValueEmitter = new Emitter<string>();
	private _onDidTriggerButtonEmitter = new Emitter<QuickInputButton>();
	private _onDidHideEmitter = new Emitter<void>();
	private _updateTimeout: number;
	private _pendingUpdate: TransferQuickInput = { id: this._id };

	private _disposed = false;
	protected _disposables: IDisposable[] = [
		this._onDidTriggerButtonEmitter,
		this._onDidHideEmitter,
		this._onDidAcceptEmitter,
		this._onDidChangeValueEmitter
	];

	constructor(protected _proxy: MainThreadQuickOpenShape, protected _extensionId: string, private _onDidDispose: () => void) {
	}

	get enabled() {
		return this._enabled;
	}

	set enabled(enabled: boolean) {
		this._enabled = enabled;
		this.update({ enabled });
	}

	get busy() {
		return this._busy;
	}

	set busy(busy: boolean) {
		this._busy = busy;
		this.update({ busy });
	}

	get ignoreFocusOut() {
		return this._ignoreFocusOut;
	}

	set ignoreFocusOut(ignoreFocusOut: boolean) {
		this._ignoreFocusOut = ignoreFocusOut;
		this.update({ ignoreFocusOut });
	}

	get value() {
		return this._value;
	}

	set value(value: string) {
		this._value = value;
		this.update({ value });
	}

	get placeholder() {
		return this._placeholder;
	}

	set placeholder(placeholder: string) {
		this._placeholder = placeholder;
		this.update({ placeholder });
	}

	onDidChangeValue = this._onDidChangeValueEmitter.event;

	onDidAccept = this._onDidAcceptEmitter.event;

	get buttons() {
		return this._buttons;
	}

	set buttons(buttons: QuickInputButton[]) {
		this._buttons = buttons;
		this._handlesToButtons.clear();
		buttons.forEach((button, i) => {
			this._handlesToButtons.set(i, button);
		});
		this.update({
			buttons: buttons.map<TransferQuickInputButton>((button, i) => ({
				iconPath: getIconUris(button.iconPath),
				toolTip: button.tooltip,
				handle: i,
			}))
		});
	}

	onDidTriggerButton = this._onDidTriggerButtonEmitter.event;

	show(): void {
		this._visible = true;
		this.update({ visible: true });
	}

	hide(): void {
		this._visible = false;
		this.update({ visible: false });
	}

	onDidHide = this._onDidHideEmitter.event;

	_fireDidAccept() {
		this._onDidAcceptEmitter.fire();
	}

	_fireDidChangeValue(value) {
		this._value = value;
		this._onDidChangeValueEmitter.fire(value);
	}

	_fireDidTriggerButton(handle: number) {
		const button = this._handlesToButtons.get(handle);
		this._onDidTriggerButtonEmitter.fire(button);
	}

	_fireDidHide() {
		this._onDidHideEmitter.fire();
	}

	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._fireDidHide();
		this._disposables = dispose(this._disposables);
		if (this._updateTimeout) {
			clearTimeout(this._updateTimeout);
			this._updateTimeout = undefined;
		}
		this._onDidDispose();
		this._proxy.$dispose(this._id);
	}

	protected update(properties: Record<string, any>): void {
		if (this._disposed) {
			return;
		}
		for (const key of Object.keys(properties)) {
			const value = properties[key];
			this._pendingUpdate[key] = value === undefined ? null : value;
		}

		if (!this._visible) {
			return;
		}

		if ('visible' in this._pendingUpdate) {
			if (this._updateTimeout) {
				clearTimeout(this._updateTimeout);
				this._updateTimeout = undefined;
			}
			this.dispatchUpdate();
		} else if (!this._updateTimeout) {
			// Defer the update so that multiple changes to setters dont cause a redraw each
			this._updateTimeout = setTimeout(() => {
				this._updateTimeout = undefined;
				this.dispatchUpdate();
			}, 0);
		}
	}

	private dispatchUpdate() {
		this._proxy.$createOrUpdate(this._pendingUpdate);
		this._pendingUpdate = { id: this._id };
	}
}

function getIconUris(iconPath: QuickInputButton['iconPath']) {
	const light = getLightIconUri(iconPath);
	return { dark: getDarkIconUri(iconPath) || light, light };
}

function getLightIconUri(iconPath: QuickInputButton['iconPath']) {
	if (iconPath && !(iconPath instanceof ThemeIcon)) {
		if (typeof iconPath === 'string'
			|| iconPath instanceof URI) {
			return getIconUri(iconPath);
		}
		return getIconUri(iconPath['light']);
	}
	return undefined;
}

function getDarkIconUri(iconPath: QuickInputButton['iconPath']) {
	if (iconPath && !(iconPath instanceof ThemeIcon) && iconPath['dark']) {
		return getIconUri(iconPath['dark']);
	}
	return undefined;
}

function getIconUri(iconPath: string | URI) {
	if (iconPath instanceof URI) {
		return iconPath;
	}
	return URI.file(iconPath);
}

class ExtHostQuickPick extends ExtHostQuickInput implements QuickPick {

	private _items: QuickPickItem[] = [];
	private _handlesToItems = new Map<number, QuickPickItem>();
	private _canSelectMany = false;
	private _matchOnDescription = true;
	private _matchOnDetail = true;
	private _activeItems: QuickPickItem[] = [];
	private _onDidChangeActiveEmitter = new Emitter<QuickPickItem[]>();
	private _selectedItems: QuickPickItem[] = [];
	private _onDidChangeSelectionEmitter = new Emitter<QuickPickItem[]>();

	constructor(proxy: MainThreadQuickOpenShape, extensionId: string, onDispose: () => void) {
		super(proxy, extensionId, onDispose);
		this._disposables.push(
			this._onDidChangeActiveEmitter,
			this._onDidChangeSelectionEmitter,
		);
		this.update({ type: 'quickPick' });
	}

	get items() {
		return this._items;
	}

	set items(items: QuickPickItem[]) {
		this._items = items;
		this._handlesToItems.clear();
		items.forEach((item, i) => {
			this._handlesToItems.set(i, item);
		});
		this.update({
			items: items.map((item, i) => ({
				label: item.label,
				description: item.description,
				handle: i,
				detail: item.detail,
				picked: item.picked
			}))
		});
	}

	get canSelectMany() {
		return this._canSelectMany;
	}

	set canSelectMany(canSelectMany: boolean) {
		this._canSelectMany = canSelectMany;
		this.update({ canSelectMany });
	}

	get matchOnDescription() {
		return this._matchOnDescription;
	}

	set matchOnDescription(matchOnDescription: boolean) {
		this._matchOnDescription = matchOnDescription;
		this.update({ matchOnDescription });
	}

	get matchOnDetail() {
		return this._matchOnDetail;
	}

	set matchOnDetail(matchOnDetail: boolean) {
		this._matchOnDetail = matchOnDetail;
		this.update({ matchOnDetail });
	}

	get activeItems() {
		return this._activeItems;
	}

	onDidChangeActive = this._onDidChangeActiveEmitter.event;

	get selectedItems() {
		return this._selectedItems;
	}

	onDidChangeSelection = this._onDidChangeSelectionEmitter.event;

	_fireDidChangeActive(handles: number[]) {
		const items = handles.map(handle => this._handlesToItems.get(handle));
		this._activeItems = items;
		this._onDidChangeActiveEmitter.fire(items);
	}

	_fireDidChangeSelection(handles: number[]) {
		const items = handles.map(handle => this._handlesToItems.get(handle));
		this._selectedItems = items;
		this._onDidChangeSelectionEmitter.fire(items);
	}
}

class ExtHostInputBox extends ExtHostQuickInput implements InputBox {

	private _password: boolean;
	private _prompt: string;
	private _validationMessage: string;

	constructor(proxy: MainThreadQuickOpenShape, extensionId: string, onDispose: () => void) {
		super(proxy, extensionId, onDispose);
		this.update({ type: 'inputBox' });
	}

	get password() {
		return this._password;
	}

	set password(password: boolean) {
		this._password = password;
		this.update({ password });
	}

	get prompt() {
		return this._prompt;
	}

	set prompt(prompt: string) {
		this._prompt = prompt;
		this.update({ prompt });
	}

	get validationMessage() {
		return this._validationMessage;
	}

	set validationMessage(validationMessage: string) {
		this._validationMessage = validationMessage;
		this.update({ validationMessage });
	}
}