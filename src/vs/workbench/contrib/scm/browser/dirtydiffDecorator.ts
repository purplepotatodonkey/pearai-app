/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../nls.js';

import './media/dirtydiffDecorator.css';
import { ThrottledDelayer } from '../../../../base/common/async.js';
import { IDisposable, dispose, toDisposable, Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import * as ext from '../../../common/contributions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { DiffAlgorithmName, IEditorWorkerService } from '../../../../editor/common/services/editorWorker.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { URI } from '../../../../base/common/uri.js';
import { ISCMService, ISCMRepository } from '../common/scm.js';
import { ModelDecorationOptions } from '../../../../editor/common/model/textModel.js';
import { IColorTheme, themeColorFromId, IThemeService } from '../../../../platform/theme/common/themeService.js';
import { editorErrorForeground, registerColor, transparent } from '../../../../platform/theme/common/colorRegistry.js';
import { ICodeEditor, IEditorMouseEvent, isCodeEditor, MouseTargetType } from '../../../../editor/browser/editorBrowser.js';
import { registerEditorAction, registerEditorContribution, ServicesAccessor, EditorAction, EditorContributionInstantiation } from '../../../../editor/browser/editorExtensions.js';
import { PeekViewWidget, getOuterEditor, peekViewBorder, peekViewTitleBackground, peekViewTitleForeground, peekViewTitleInfoForeground } from '../../../../editor/contrib/peekView/browser/peekView.js';
import { IContextKeyService, IContextKey, ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { rot } from '../../../../base/common/numbers.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { EmbeddedDiffEditorWidget } from '../../../../editor/browser/widget/diffEditor/embeddedDiffEditorWidget.js';
import { IDiffEditorOptions, EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { Action, IAction, ActionRunner } from '../../../../base/common/actions.js';
import { IActionBarOptions } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { basename } from '../../../../base/common/resources.js';
import { MenuId, IMenuService, IMenu, MenuItemAction, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { getFlatActionBarActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { ScrollType, IEditorContribution, IDiffEditorModel, IEditorModel, IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';
import { OverviewRulerLane, ITextModel, IModelDecorationOptions, MinimapPosition, shouldSynchronizeModel } from '../../../../editor/common/model.js';
import { equals, sortedDiff } from '../../../../base/common/arrays.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ISplice } from '../../../../base/common/sequence.js';
import * as dom from '../../../../base/browser/dom.js';
import * as domStylesheetsJs from '../../../../base/browser/domStylesheets.js';
import { EncodingMode, ITextFileEditorModel, IResolvedTextFileEditorModel, ITextFileService, isTextFileEditorModel } from '../../../services/textfile/common/textfiles.js';
import { gotoNextLocation, gotoPreviousLocation } from '../../../../platform/theme/common/iconRegistry.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { TextCompareEditorActiveContext } from '../../../common/contextkeys.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IChange } from '../../../../editor/common/diff/legacyLinesDiffComputer.js';
import { Color } from '../../../../base/common/color.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IQuickDiffService, QuickDiff, QuickDiffResult } from '../common/quickDiff.js';
import { IQuickDiffSelectItem, SwitchQuickDiffBaseAction, SwitchQuickDiffViewItem } from './dirtyDiffSwitcher.js';
import { IChatEditingService, WorkingSetEntryState } from '../../chat/common/chatEditingService.js';
import { lineRangeMappingFromChanges } from '../../../../editor/common/diff/rangeMapping.js';
import { DiffState } from '../../../../editor/browser/widget/diffEditor/diffEditorViewModel.js';
import { toLineChanges } from '../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';

class DiffActionRunner extends ActionRunner {

	protected override runAction(action: IAction, context: any): Promise<any> {
		if (action instanceof MenuItemAction) {
			return action.run(...context);
		}

		return super.runAction(action, context);
	}
}

export interface IModelRegistry {
	getModel(editorModel: IEditorModel, codeEditor: ICodeEditor): DirtyDiffModel | undefined;
}

export interface DirtyDiffContribution extends IEditorContribution {
	getChanges(): IChange[];
}

export const isDirtyDiffVisible = new RawContextKey<boolean>('dirtyDiffVisible', false);

function getChangeHeight(change: IChange): number {
	const modified = change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1;
	const original = change.originalEndLineNumber - change.originalStartLineNumber + 1;

	if (change.originalEndLineNumber === 0) {
		return modified;
	} else if (change.modifiedEndLineNumber === 0) {
		return original;
	} else {
		return modified + original;
	}
}

function getModifiedEndLineNumber(change: IChange): number {
	if (change.modifiedEndLineNumber === 0) {
		return change.modifiedStartLineNumber === 0 ? 1 : change.modifiedStartLineNumber;
	} else {
		return change.modifiedEndLineNumber;
	}
}

function lineIntersectsChange(lineNumber: number, change: IChange): boolean {
	// deletion at the beginning of the file
	if (lineNumber === 1 && change.modifiedStartLineNumber === 0 && change.modifiedEndLineNumber === 0) {
		return true;
	}

	return lineNumber >= change.modifiedStartLineNumber && lineNumber <= (change.modifiedEndLineNumber || change.modifiedStartLineNumber);
}

class UIEditorAction extends Action {

	private editor: ICodeEditor;
	private action: EditorAction;
	private instantiationService: IInstantiationService;

	constructor(
		editor: ICodeEditor,
		action: EditorAction,
		cssClass: string,
		@IKeybindingService keybindingService: IKeybindingService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		const keybinding = keybindingService.lookupKeybinding(action.id);
		const label = action.label + (keybinding ? ` (${keybinding.getLabel()})` : '');

		super(action.id, label, cssClass);

		this.instantiationService = instantiationService;
		this.action = action;
		this.editor = editor;
	}

	override run(): Promise<any> {
		return Promise.resolve(this.instantiationService.invokeFunction(accessor => this.action.run(accessor, this.editor, null)));
	}
}

enum ChangeType {
	Modify,
	Add,
	Delete
}

function getChangeType(change: IChange): ChangeType {
	if (change.originalEndLineNumber === 0) {
		return ChangeType.Add;
	} else if (change.modifiedEndLineNumber === 0) {
		return ChangeType.Delete;
	} else {
		return ChangeType.Modify;
	}
}

function getChangeTypeColor(theme: IColorTheme, changeType: ChangeType): Color | undefined {
	switch (changeType) {
		case ChangeType.Modify: return theme.getColor(editorGutterModifiedBackground);
		case ChangeType.Add: return theme.getColor(editorGutterAddedBackground);
		case ChangeType.Delete: return theme.getColor(editorGutterDeletedBackground);
	}
}

function getOuterEditorFromDiffEditor(accessor: ServicesAccessor): ICodeEditor | null {
	const diffEditors = accessor.get(ICodeEditorService).listDiffEditors();

	for (const diffEditor of diffEditors) {
		if (diffEditor.hasTextFocus() && diffEditor instanceof EmbeddedDiffEditorWidget) {
			return diffEditor.getParentEditor();
		}
	}

	return getOuterEditor(accessor);
}

class DirtyDiffWidget extends PeekViewWidget {

	private diffEditor!: EmbeddedDiffEditorWidget;
	private title: string;
	private menu: IMenu | undefined;
	private _index: number = 0;
	private _provider: string = '';
	private change: IChange | undefined;
	private height: number | undefined = undefined;
	private dropdown: SwitchQuickDiffViewItem | undefined;
	private dropdownContainer: HTMLElement | undefined;

	constructor(
		editor: ICodeEditor,
		private model: DirtyDiffModel,
		@IThemeService private readonly themeService: IThemeService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IMenuService private readonly menuService: IMenuService,
		@IContextKeyService private contextKeyService: IContextKeyService
	) {
		super(editor, { isResizeable: true, frameWidth: 1, keepEditorSelection: true, className: 'dirty-diff' }, instantiationService);

		this._disposables.add(themeService.onDidColorThemeChange(this._applyTheme, this));
		this._applyTheme(themeService.getColorTheme());

		if (this.model.original.length > 0) {
			contextKeyService = contextKeyService.createOverlay([['originalResourceScheme', this.model.original[0].uri.scheme], ['originalResourceSchemes', this.model.original.map(original => original.uri.scheme)]]);
		}

		this.create();
		if (editor.hasModel()) {
			this.title = basename(editor.getModel().uri);
		} else {
			this.title = '';
		}
		this.setTitle(this.title);
	}

	get provider(): string {
		return this._provider;
	}

	get index(): number {
		return this._index;
	}

	get visibleRange(): Range | undefined {
		const visibleRanges = this.diffEditor.getModifiedEditor().getVisibleRanges();
		return visibleRanges.length >= 0 ? visibleRanges[0] : undefined;
	}

	showChange(index: number, usePosition: boolean = true): void {
		const labeledChange = this.model.changes[index];
		const change = labeledChange.change;
		this._index = index;
		this.contextKeyService.createKey('originalResourceScheme', this.model.changes[index].uri.scheme);
		this.updateActions();

		this._provider = labeledChange.label;
		this.change = change;

		const originalModel = this.model.original;

		if (!originalModel) {
			return;
		}

		const onFirstDiffUpdate = Event.once(this.diffEditor.onDidUpdateDiff);

		// TODO@joao TODO@alex need this setTimeout probably because the
		// non-side-by-side diff still hasn't created the view zones
		onFirstDiffUpdate(() => setTimeout(() => this.revealChange(change), 0));

		const diffEditorModel = this.model.getDiffEditorModel(labeledChange.uri.toString());
		if (!diffEditorModel) {
			return;
		}
		this.diffEditor.setModel(diffEditorModel);
		this.dropdown?.setSelection(labeledChange.label);

		const position = new Position(getModifiedEndLineNumber(change), 1);

		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		const editorHeight = this.editor.getLayoutInfo().height;
		const editorHeightInLines = Math.floor(editorHeight / lineHeight);
		const height = Math.min(getChangeHeight(change) + /* padding */ 8, Math.floor(editorHeightInLines / 3));

		this.renderTitle(labeledChange.label);

		const changeType = getChangeType(change);
		const changeTypeColor = getChangeTypeColor(this.themeService.getColorTheme(), changeType);
		this.style({ frameColor: changeTypeColor, arrowColor: changeTypeColor });

		const providerSpecificChanges: IChange[] = [];
		let contextIndex = index;
		for (const change of this.model.changes) {
			if (change.label === this.model.changes[this._index].label) {
				providerSpecificChanges.push(change.change);
				if (labeledChange === change) {
					contextIndex = providerSpecificChanges.length - 1;
				}
			}
		}
		this._actionbarWidget!.context = [diffEditorModel.modified.uri, providerSpecificChanges, contextIndex];
		if (usePosition) {
			this.show(position, height);
			this.editor.setPosition(position);
			this.editor.focus();
		}
	}

	private renderTitle(label: string): void {
		const providerChanges = this.model.mapChanges.get(label)!;
		const providerIndex = providerChanges.indexOf(this._index);

		let detail: string;
		if (!this.shouldUseDropdown()) {
			detail = this.model.changes.length > 1
				? nls.localize('changes', "{0} - {1} of {2} changes", label, providerIndex + 1, providerChanges.length)
				: nls.localize('change', "{0} - {1} of {2} change", label, providerIndex + 1, providerChanges.length);
			this.dropdownContainer!.style.display = 'none';
		} else {
			detail = this.model.changes.length > 1
				? nls.localize('multiChanges', "{0} of {1} changes", providerIndex + 1, providerChanges.length)
				: nls.localize('multiChange', "{0} of {1} change", providerIndex + 1, providerChanges.length);
			this.dropdownContainer!.style.display = 'inherit';
		}

		this.setTitle(this.title, detail);
	}

	private switchQuickDiff(event?: IQuickDiffSelectItem) {
		const newProvider = event?.provider;
		if (newProvider === this.model.changes[this._index].label) {
			return;
		}
		let closestGreaterIndex = this._index < this.model.changes.length - 1 ? this._index + 1 : 0;
		for (let i = closestGreaterIndex; i !== this._index; i < this.model.changes.length - 1 ? i++ : i = 0) {
			if (this.model.changes[i].label === newProvider) {
				closestGreaterIndex = i;
				break;
			}
		}
		let closestLesserIndex = this._index > 0 ? this._index - 1 : this.model.changes.length - 1;
		for (let i = closestLesserIndex; i !== this._index; i >= 0 ? i-- : i = this.model.changes.length - 1) {
			if (this.model.changes[i].label === newProvider) {
				closestLesserIndex = i;
				break;
			}
		}
		const closestIndex = Math.abs(this.model.changes[closestGreaterIndex].change.modifiedEndLineNumber - this.model.changes[this._index].change.modifiedEndLineNumber)
			< Math.abs(this.model.changes[closestLesserIndex].change.modifiedEndLineNumber - this.model.changes[this._index].change.modifiedEndLineNumber)
			? closestGreaterIndex : closestLesserIndex;
		this.showChange(closestIndex, false);
	}

	private shouldUseDropdown(): boolean {
		let providersWithChangesCount = 0;
		if (this.model.mapChanges.size > 1) {
			const keys = Array.from(this.model.mapChanges.keys());
			for (let i = 0; (i < keys.length) && (providersWithChangesCount <= 1); i++) {
				if (this.model.mapChanges.get(keys[i])!.length > 0) {
					providersWithChangesCount++;
				}
			}
		}
		return providersWithChangesCount >= 2;
	}

	private updateActions(): void {
		if (!this._actionbarWidget) {
			return;
		}
		const previous = this.instantiationService.createInstance(UIEditorAction, this.editor, new ShowPreviousChangeAction(this.editor), ThemeIcon.asClassName(gotoPreviousLocation));
		const next = this.instantiationService.createInstance(UIEditorAction, this.editor, new ShowNextChangeAction(this.editor), ThemeIcon.asClassName(gotoNextLocation));

		this._disposables.add(previous);
		this._disposables.add(next);

		if (this.menu) {
			this.menu.dispose();
		}
		this.menu = this.menuService.createMenu(MenuId.SCMChangeContext, this.contextKeyService);
		const actions = getFlatActionBarActions(this.menu.getActions({ shouldForwardArgs: true }));
		this._actionbarWidget.clear();
		this._actionbarWidget.push(actions.reverse(), { label: false, icon: true });
		this._actionbarWidget.push([next, previous], { label: false, icon: true });
		this._actionbarWidget.push(new Action('peekview.close', nls.localize('label.close', "Close"), ThemeIcon.asClassName(Codicon.close), true, () => this.dispose()), { label: false, icon: true });
	}

	protected override _fillHead(container: HTMLElement): void {
		super._fillHead(container, true);

		this.dropdownContainer = dom.prepend(this._titleElement!, dom.$('.dropdown'));
		this.dropdown = this.instantiationService.createInstance(SwitchQuickDiffViewItem, new SwitchQuickDiffBaseAction((event?: IQuickDiffSelectItem) => this.switchQuickDiff(event)),
			this.model.quickDiffs.map(quickDiffer => quickDiffer.label), this.model.changes[this._index].label);
		this.dropdown.render(this.dropdownContainer);
		this.updateActions();
	}

	protected override _getActionBarOptions(): IActionBarOptions {
		const actionRunner = new DiffActionRunner();

		// close widget on successful action
		actionRunner.onDidRun(e => {
			if (!(e.action instanceof UIEditorAction) && !e.error) {
				this.dispose();
			}
		});

		return {
			...super._getActionBarOptions(),
			actionRunner
		};
	}

	protected _fillBody(container: HTMLElement): void {
		const options: IDiffEditorOptions = {
			scrollBeyondLastLine: true,
			scrollbar: {
				verticalScrollbarSize: 14,
				horizontal: 'auto',
				useShadows: true,
				verticalHasArrows: false,
				horizontalHasArrows: false
			},
			overviewRulerLanes: 2,
			fixedOverflowWidgets: true,
			minimap: { enabled: false },
			renderSideBySide: false,
			readOnly: false,
			renderIndicators: false,
			diffAlgorithm: 'advanced',
			ignoreTrimWhitespace: false,
			stickyScroll: { enabled: false }
		};

		this.diffEditor = this.instantiationService.createInstance(EmbeddedDiffEditorWidget, container, options, {}, this.editor);
		this._disposables.add(this.diffEditor);
	}

	protected override _onWidth(width: number): void {
		if (typeof this.height === 'undefined') {
			return;
		}

		this.diffEditor.layout({ height: this.height, width });
	}

	protected override _doLayoutBody(height: number, width: number): void {
		super._doLayoutBody(height, width);
		this.diffEditor.layout({ height, width });

		if (typeof this.height === 'undefined' && this.change) {
			this.revealChange(this.change);
		}

		this.height = height;
	}

	private revealChange(change: IChange): void {
		let start: number, end: number;

		if (change.modifiedEndLineNumber === 0) { // deletion
			start = change.modifiedStartLineNumber;
			end = change.modifiedStartLineNumber + 1;
		} else if (change.originalEndLineNumber > 0) { // modification
			start = change.modifiedStartLineNumber - 1;
			end = change.modifiedEndLineNumber + 1;
		} else { // insertion
			start = change.modifiedStartLineNumber;
			end = change.modifiedEndLineNumber;
		}

		this.diffEditor.revealLinesInCenter(start, end, ScrollType.Immediate);
	}

	private _applyTheme(theme: IColorTheme) {
		const borderColor = theme.getColor(peekViewBorder) || Color.transparent;
		this.style({
			arrowColor: borderColor,
			frameColor: borderColor,
			headerBackgroundColor: theme.getColor(peekViewTitleBackground) || Color.transparent,
			primaryHeadingColor: theme.getColor(peekViewTitleForeground),
			secondaryHeadingColor: theme.getColor(peekViewTitleInfoForeground)
		});
	}

	protected override revealRange(range: Range) {
		this.editor.revealLineInCenterIfOutsideViewport(range.endLineNumber, ScrollType.Smooth);
	}

	override hasFocus(): boolean {
		return this.diffEditor.hasTextFocus();
	}

	override dispose() {
		super.dispose();
		this.menu?.dispose();
	}
}

export class ShowPreviousChangeAction extends EditorAction {

	constructor(private readonly outerEditor?: ICodeEditor) {
		super({
			id: 'editor.action.dirtydiff.previous',
			label: nls.localize2('show previous change', "Show Previous Change"),
			precondition: TextCompareEditorActiveContext.toNegated(),
			kbOpts: { kbExpr: EditorContextKeys.editorTextFocus, primary: KeyMod.Shift | KeyMod.Alt | KeyCode.F3, weight: KeybindingWeight.EditorContrib }
		});
	}

	run(accessor: ServicesAccessor): void {
		const outerEditor = this.outerEditor ?? getOuterEditorFromDiffEditor(accessor);

		if (!outerEditor) {
			return;
		}

		const controller = DirtyDiffController.get(outerEditor);

		if (!controller) {
			return;
		}

		if (!controller.canNavigate()) {
			return;
		}

		controller.previous();
	}
}
registerEditorAction(ShowPreviousChangeAction);

export class ShowNextChangeAction extends EditorAction {

	constructor(private readonly outerEditor?: ICodeEditor) {
		super({
			id: 'editor.action.dirtydiff.next',
			label: nls.localize2('show next change', "Show Next Change"),
			precondition: TextCompareEditorActiveContext.toNegated(),
			kbOpts: { kbExpr: EditorContextKeys.editorTextFocus, primary: KeyMod.Alt | KeyCode.F3, weight: KeybindingWeight.EditorContrib }
		});
	}

	run(accessor: ServicesAccessor): void {
		const outerEditor = this.outerEditor ?? getOuterEditorFromDiffEditor(accessor);

		if (!outerEditor) {
			return;
		}

		const controller = DirtyDiffController.get(outerEditor);

		if (!controller) {
			return;
		}

		if (!controller.canNavigate()) {
			return;
		}

		controller.next();
	}
}
registerEditorAction(ShowNextChangeAction);

// Go to menu
MenuRegistry.appendMenuItem(MenuId.MenubarGoMenu, {
	group: '7_change_nav',
	command: {
		id: 'editor.action.dirtydiff.next',
		title: nls.localize({ key: 'miGotoNextChange', comment: ['&& denotes a mnemonic'] }, "Next &&Change")
	},
	order: 1
});

MenuRegistry.appendMenuItem(MenuId.MenubarGoMenu, {
	group: '7_change_nav',
	command: {
		id: 'editor.action.dirtydiff.previous',
		title: nls.localize({ key: 'miGotoPreviousChange', comment: ['&& denotes a mnemonic'] }, "Previous &&Change")
	},
	order: 2
});

export class GotoPreviousChangeAction extends EditorAction {

	constructor() {
		super({
			id: 'workbench.action.editor.previousChange',
			label: nls.localize2('move to previous change', "Go to Previous Change"),
			precondition: TextCompareEditorActiveContext.toNegated(),
			kbOpts: { kbExpr: EditorContextKeys.editorTextFocus, primary: KeyMod.Shift | KeyMod.Alt | KeyCode.F5, weight: KeybindingWeight.EditorContrib }
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const outerEditor = getOuterEditorFromDiffEditor(accessor);
		const accessibilitySignalService = accessor.get(IAccessibilitySignalService);
		const accessibilityService = accessor.get(IAccessibilityService);
		const codeEditorService = accessor.get(ICodeEditorService);

		if (!outerEditor || !outerEditor.hasModel()) {
			return;
		}

		const controller = DirtyDiffController.get(outerEditor);

		if (!controller || !controller.modelRegistry) {
			return;
		}

		const lineNumber = outerEditor.getPosition().lineNumber;
		const model = controller.modelRegistry.getModel(outerEditor.getModel(), outerEditor);
		if (!model || model.changes.length === 0) {
			return;
		}

		const index = model.findPreviousClosestChange(lineNumber, false);
		const change = model.changes[index];
		await playAccessibilitySymbolForChange(change.change, accessibilitySignalService);
		setPositionAndSelection(change.change, outerEditor, accessibilityService, codeEditorService);
	}
}
registerEditorAction(GotoPreviousChangeAction);

export class GotoNextChangeAction extends EditorAction {

	constructor() {
		super({
			id: 'workbench.action.editor.nextChange',
			label: nls.localize2('move to next change', "Go to Next Change"),
			precondition: TextCompareEditorActiveContext.toNegated(),
			kbOpts: { kbExpr: EditorContextKeys.editorTextFocus, primary: KeyMod.Alt | KeyCode.F5, weight: KeybindingWeight.EditorContrib }
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const accessibilitySignalService = accessor.get(IAccessibilitySignalService);
		const outerEditor = getOuterEditorFromDiffEditor(accessor);
		const accessibilityService = accessor.get(IAccessibilityService);
		const codeEditorService = accessor.get(ICodeEditorService);

		if (!outerEditor || !outerEditor.hasModel()) {
			return;
		}

		const controller = DirtyDiffController.get(outerEditor);

		if (!controller || !controller.modelRegistry) {
			return;
		}

		const lineNumber = outerEditor.getPosition().lineNumber;
		const model = controller.modelRegistry.getModel(outerEditor.getModel(), outerEditor);

		if (!model || model.changes.length === 0) {
			return;
		}

		const index = model.findNextClosestChange(lineNumber, false);
		const change = model.changes[index].change;
		await playAccessibilitySymbolForChange(change, accessibilitySignalService);
		setPositionAndSelection(change, outerEditor, accessibilityService, codeEditorService);
	}
}

function setPositionAndSelection(change: IChange, editor: ICodeEditor, accessibilityService: IAccessibilityService, codeEditorService: ICodeEditorService) {
	const position = new Position(change.modifiedStartLineNumber, 1);
	editor.setPosition(position);
	editor.revealPositionInCenter(position);
	if (accessibilityService.isScreenReaderOptimized()) {
		editor.setSelection({ startLineNumber: change.modifiedStartLineNumber, startColumn: 0, endLineNumber: change.modifiedStartLineNumber, endColumn: Number.MAX_VALUE });
		codeEditorService.getActiveCodeEditor()?.writeScreenReaderContent('diff-navigation');
	}
}

async function playAccessibilitySymbolForChange(change: IChange, accessibilitySignalService: IAccessibilitySignalService) {
	const changeType = getChangeType(change);
	switch (changeType) {
		case ChangeType.Add:
			accessibilitySignalService.playSignal(AccessibilitySignal.diffLineInserted, { allowManyInParallel: true, source: 'dirtyDiffDecoration' });
			break;
		case ChangeType.Delete:
			accessibilitySignalService.playSignal(AccessibilitySignal.diffLineDeleted, { allowManyInParallel: true, source: 'dirtyDiffDecoration' });
			break;
		case ChangeType.Modify:
			accessibilitySignalService.playSignal(AccessibilitySignal.diffLineModified, { allowManyInParallel: true, source: 'dirtyDiffDecoration' });
			break;
	}
}

registerEditorAction(GotoNextChangeAction);

KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: 'closeDirtyDiff',
	weight: KeybindingWeight.EditorContrib + 50,
	primary: KeyCode.Escape,
	secondary: [KeyMod.Shift | KeyCode.Escape],
	when: ContextKeyExpr.and(isDirtyDiffVisible),
	handler: (accessor: ServicesAccessor) => {
		const outerEditor = getOuterEditorFromDiffEditor(accessor);

		if (!outerEditor) {
			return;
		}

		const controller = DirtyDiffController.get(outerEditor);

		if (!controller) {
			return;
		}

		controller.close();
	}
});

export class DirtyDiffController extends Disposable implements DirtyDiffContribution {

	public static readonly ID = 'editor.contrib.dirtydiff';

	static get(editor: ICodeEditor): DirtyDiffController | null {
		return editor.getContribution<DirtyDiffController>(DirtyDiffController.ID);
	}

	modelRegistry: IModelRegistry | null = null;

	private model: DirtyDiffModel | null = null;
	private widget: DirtyDiffWidget | null = null;
	private readonly isDirtyDiffVisible!: IContextKey<boolean>;
	private session: IDisposable = Disposable.None;
	private mouseDownInfo: { lineNumber: number } | null = null;
	private enabled = false;
	private readonly gutterActionDisposables = new DisposableStore();
	private stylesheet: HTMLStyleElement;

	constructor(
		private editor: ICodeEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();
		this.enabled = !contextKeyService.getContextKeyValue('isInDiffEditor');
		this.stylesheet = domStylesheetsJs.createStyleSheet(undefined, undefined, this._store);

		if (this.enabled) {
			this.isDirtyDiffVisible = isDirtyDiffVisible.bindTo(contextKeyService);
			this._register(editor.onDidChangeModel(() => this.close()));

			const onDidChangeGutterAction = Event.filter(configurationService.onDidChangeConfiguration, e => e.affectsConfiguration('scm.diffDecorationsGutterAction'));
			this._register(onDidChangeGutterAction(this.onDidChangeGutterAction, this));
			this.onDidChangeGutterAction();
		}
	}

	private onDidChangeGutterAction(): void {
		const gutterAction = this.configurationService.getValue<'diff' | 'none'>('scm.diffDecorationsGutterAction');

		this.gutterActionDisposables.clear();

		if (gutterAction === 'diff') {
			this.gutterActionDisposables.add(this.editor.onMouseDown(e => this.onEditorMouseDown(e)));
			this.gutterActionDisposables.add(this.editor.onMouseUp(e => this.onEditorMouseUp(e)));
			this.stylesheet.textContent = `
				.monaco-editor .dirty-diff-glyph {
					cursor: pointer;
				}

				.monaco-editor .margin-view-overlays .dirty-diff-glyph:hover::before {
					height: 100%;
					width: 6px;
					left: -6px;
				}

				.monaco-editor .margin-view-overlays .dirty-diff-deleted:hover::after {
					bottom: 0;
					border-top-width: 0;
					border-bottom-width: 0;
				}
			`;
		} else {
			this.stylesheet.textContent = ``;
		}
	}

	canNavigate(): boolean {
		return !this.widget || (this.widget?.index === -1) || (!!this.model && this.model.changes.length > 1);
	}

	refresh(): void {
		this.widget?.showChange(this.widget.index, false);
	}

	next(lineNumber?: number): void {
		if (!this.assertWidget()) {
			return;
		}
		if (!this.widget || !this.model) {
			return;
		}

		let index: number;
		if (this.editor.hasModel() && (typeof lineNumber === 'number' || !this.widget.provider)) {
			index = this.model.findNextClosestChange(typeof lineNumber === 'number' ? lineNumber : this.editor.getPosition().lineNumber, true, this.widget.provider);
		} else {
			const providerChanges: number[] = this.model.mapChanges.get(this.widget.provider) ?? this.model.mapChanges.values().next().value!;
			const mapIndex = providerChanges.findIndex(value => value === this.widget!.index);
			index = providerChanges[rot(mapIndex + 1, providerChanges.length)];
		}

		this.widget.showChange(index);
	}

	previous(lineNumber?: number): void {
		if (!this.assertWidget()) {
			return;
		}
		if (!this.widget || !this.model) {
			return;
		}

		let index: number;
		if (this.editor.hasModel() && (typeof lineNumber === 'number')) {
			index = this.model.findPreviousClosestChange(typeof lineNumber === 'number' ? lineNumber : this.editor.getPosition().lineNumber, true, this.widget.provider);
		} else {
			const providerChanges: number[] = this.model.mapChanges.get(this.widget.provider) ?? this.model.mapChanges.values().next().value!;
			const mapIndex = providerChanges.findIndex(value => value === this.widget!.index);
			index = providerChanges[rot(mapIndex - 1, providerChanges.length)];
		}

		this.widget.showChange(index);
	}

	close(): void {
		this.session.dispose();
		this.session = Disposable.None;
	}

	private assertWidget(): boolean {
		if (!this.enabled) {
			return false;
		}

		if (this.widget) {
			if (!this.model || this.model.changes.length === 0) {
				this.close();
				return false;
			}

			return true;
		}

		if (!this.modelRegistry) {
			return false;
		}

		const editorModel = this.editor.getModel();

		if (!editorModel) {
			return false;
		}

		const model = this.modelRegistry.getModel(editorModel, this.editor);

		if (!model) {
			return false;
		}

		if (model.changes.length === 0) {
			return false;
		}

		this.model = model;
		this.widget = this.instantiationService.createInstance(DirtyDiffWidget, this.editor, model);
		this.isDirtyDiffVisible.set(true);

		const disposables = new DisposableStore();
		disposables.add(Event.once(this.widget.onDidClose)(this.close, this));
		const onDidModelChange = Event.chain(model.onDidChange, $ =>
			$.filter(e => e.diff.length > 0)
				.map(e => e.diff)
		);

		onDidModelChange(this.onDidModelChange, this, disposables);

		disposables.add(this.widget);
		disposables.add(toDisposable(() => {
			this.model = null;
			this.widget = null;
			this.isDirtyDiffVisible.set(false);
			this.editor.focus();
		}));

		this.session = disposables;
		return true;
	}

	private onDidModelChange(splices: ISplice<LabeledChange>[]): void {
		if (!this.model || !this.widget || this.widget.hasFocus()) {
			return;
		}

		for (const splice of splices) {
			if (splice.start <= this.widget.index) {
				this.next();
				return;
			}
		}

		this.refresh();
	}

	private onEditorMouseDown(e: IEditorMouseEvent): void {
		this.mouseDownInfo = null;

		const range = e.target.range;

		if (!range) {
			return;
		}

		if (!e.event.leftButton) {
			return;
		}

		if (e.target.type !== MouseTargetType.GUTTER_LINE_DECORATIONS) {
			return;
		}
		if (!e.target.element) {
			return;
		}
		if (e.target.element.className.indexOf('dirty-diff-glyph') < 0) {
			return;
		}

		const data = e.target.detail;
		const offsetLeftInGutter = e.target.element.offsetLeft;
		const gutterOffsetX = data.offsetX - offsetLeftInGutter;

		// TODO@joao TODO@alex TODO@martin this is such that we don't collide with folding
		if (gutterOffsetX < -3 || gutterOffsetX > 3) { // dirty diff decoration on hover is 6px wide
			return;
		}

		this.mouseDownInfo = { lineNumber: range.startLineNumber };
	}

	private onEditorMouseUp(e: IEditorMouseEvent): void {
		if (!this.mouseDownInfo) {
			return;
		}

		const { lineNumber } = this.mouseDownInfo;
		this.mouseDownInfo = null;

		const range = e.target.range;

		if (!range || range.startLineNumber !== lineNumber) {
			return;
		}

		if (e.target.type !== MouseTargetType.GUTTER_LINE_DECORATIONS) {
			return;
		}

		if (!this.modelRegistry) {
			return;
		}

		const editorModel = this.editor.getModel();

		if (!editorModel) {
			return;
		}

		const model = this.modelRegistry.getModel(editorModel, this.editor);

		if (!model) {
			return;
		}

		const index = model.changes.findIndex(change => lineIntersectsChange(lineNumber, change.change));

		if (index < 0) {
			return;
		}

		if (index === this.widget?.index) {
			this.close();
		} else {
			this.next(lineNumber);
		}
	}

	getChanges(): IChange[] {
		if (!this.modelRegistry) {
			return [];
		}
		if (!this.editor.hasModel()) {
			return [];
		}

		const model = this.modelRegistry.getModel(this.editor.getModel(), this.editor);

		if (!model) {
			return [];
		}

		return model.changes.map(change => change.change);
	}

	override dispose(): void {
		this.gutterActionDisposables.dispose();
		super.dispose();
	}
}

const editorGutterModifiedBackground = registerColor('editorGutter.modifiedBackground', {
	dark: '#1B81A8',
	light: '#2090D3',
	hcDark: '#1B81A8',
	hcLight: '#2090D3'
}, nls.localize('editorGutterModifiedBackground', "Editor gutter background color for lines that are modified."));

const editorGutterAddedBackground = registerColor('editorGutter.addedBackground', {
	dark: '#487E02',
	light: '#48985D',
	hcDark: '#487E02',
	hcLight: '#48985D'
}, nls.localize('editorGutterAddedBackground', "Editor gutter background color for lines that are added."));

const editorGutterDeletedBackground = registerColor('editorGutter.deletedBackground', editorErrorForeground, nls.localize('editorGutterDeletedBackground', "Editor gutter background color for lines that are deleted."));

export const minimapGutterModifiedBackground = registerColor('minimapGutter.modifiedBackground', editorGutterModifiedBackground, nls.localize('minimapGutterModifiedBackground', "Minimap gutter background color for lines that are modified."));

export const minimapGutterAddedBackground = registerColor('minimapGutter.addedBackground', editorGutterAddedBackground, nls.localize('minimapGutterAddedBackground', "Minimap gutter background color for lines that are added."));

export const minimapGutterDeletedBackground = registerColor('minimapGutter.deletedBackground', editorGutterDeletedBackground, nls.localize('minimapGutterDeletedBackground', "Minimap gutter background color for lines that are deleted."));

export const overviewRulerModifiedForeground = registerColor('editorOverviewRuler.modifiedForeground', transparent(editorGutterModifiedBackground, 0.6), nls.localize('overviewRulerModifiedForeground', 'Overview ruler marker color for modified content.'));
export const overviewRulerAddedForeground = registerColor('editorOverviewRuler.addedForeground', transparent(editorGutterAddedBackground, 0.6), nls.localize('overviewRulerAddedForeground', 'Overview ruler marker color for added content.'));
export const overviewRulerDeletedForeground = registerColor('editorOverviewRuler.deletedForeground', transparent(editorGutterDeletedBackground, 0.6), nls.localize('overviewRulerDeletedForeground', 'Overview ruler marker color for deleted content.'));

class DirtyDiffDecorator extends Disposable {

	static createDecoration(className: string, tooltip: string | null, options: { gutter: boolean; overview: { active: boolean; color: string }; minimap: { active: boolean; color: string }; isWholeLine: boolean }): ModelDecorationOptions {
		const decorationOptions: IModelDecorationOptions = {
			description: 'dirty-diff-decoration',
			isWholeLine: options.isWholeLine,
		};

		if (options.gutter) {
			decorationOptions.linesDecorationsClassName = `dirty-diff-glyph ${className}`;
			decorationOptions.linesDecorationsTooltip = tooltip;
		}

		if (options.overview.active) {
			decorationOptions.overviewRuler = {
				color: themeColorFromId(options.overview.color),
				position: OverviewRulerLane.Left
			};
		}

		if (options.minimap.active) {
			decorationOptions.minimap = {
				color: themeColorFromId(options.minimap.color),
				position: MinimapPosition.Gutter
			};
		}

		return ModelDecorationOptions.createDynamic(decorationOptions);
	}

	private addedOptions: ModelDecorationOptions;
	private addedPatternOptions: ModelDecorationOptions;
	private modifiedOptions: ModelDecorationOptions;
	private modifiedPatternOptions: ModelDecorationOptions;
	private deletedOptions: ModelDecorationOptions;
	private decorationsCollection: IEditorDecorationsCollection | undefined;
	private editorModel: ITextModel | null;

	constructor(
		editorModel: ITextModel,
		private readonly codeEditor: ICodeEditor,
		private model: DirtyDiffModel,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super();
		this.editorModel = editorModel;

		const decorations = configurationService.getValue<string>('scm.diffDecorations');
		const gutter = decorations === 'all' || decorations === 'gutter';
		const overview = decorations === 'all' || decorations === 'overview';
		const minimap = decorations === 'all' || decorations === 'minimap';

		const diffAdded = nls.localize('diffAdded', 'Added lines');
		this.addedOptions = DirtyDiffDecorator.createDecoration('dirty-diff-added', diffAdded, {
			gutter,
			overview: { active: overview, color: overviewRulerAddedForeground },
			minimap: { active: minimap, color: minimapGutterAddedBackground },
			isWholeLine: true
		});
		this.addedPatternOptions = DirtyDiffDecorator.createDecoration('dirty-diff-added-pattern', diffAdded, {
			gutter,
			overview: { active: overview, color: overviewRulerAddedForeground },
			minimap: { active: minimap, color: minimapGutterAddedBackground },
			isWholeLine: true
		});
		const diffModified = nls.localize('diffModified', 'Changed lines');
		this.modifiedOptions = DirtyDiffDecorator.createDecoration('dirty-diff-modified', diffModified, {
			gutter,
			overview: { active: overview, color: overviewRulerModifiedForeground },
			minimap: { active: minimap, color: minimapGutterModifiedBackground },
			isWholeLine: true
		});
		this.modifiedPatternOptions = DirtyDiffDecorator.createDecoration('dirty-diff-modified-pattern', diffModified, {
			gutter,
			overview: { active: overview, color: overviewRulerModifiedForeground },
			minimap: { active: minimap, color: minimapGutterModifiedBackground },
			isWholeLine: true
		});
		this.deletedOptions = DirtyDiffDecorator.createDecoration('dirty-diff-deleted', nls.localize('diffDeleted', 'Removed lines'), {
			gutter,
			overview: { active: overview, color: overviewRulerDeletedForeground },
			minimap: { active: minimap, color: minimapGutterDeletedBackground },
			isWholeLine: false
		});

		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('scm.diffDecorationsGutterPattern')) {
				this.onDidChange();
			}
		}));

		this._register(model.onDidChange(this.onDidChange, this));
	}

	private onDidChange(): void {
		if (!this.editorModel) {
			return;
		}

		const visibleQuickDiffs = this.model.quickDiffs.filter(quickDiff => quickDiff.visible);
		const pattern = this.configurationService.getValue<{ added: boolean; modified: boolean }>('scm.diffDecorationsGutterPattern');

		const decorations = this.model.changes
			.filter(labeledChange => visibleQuickDiffs.some(quickDiff => quickDiff.label === labeledChange.label))
			.map((labeledChange) => {
				const change = labeledChange.change;
				const changeType = getChangeType(change);
				const startLineNumber = change.modifiedStartLineNumber;
				const endLineNumber = change.modifiedEndLineNumber || startLineNumber;

				switch (changeType) {
					case ChangeType.Add:
						return {
							range: {
								startLineNumber: startLineNumber, startColumn: 1,
								endLineNumber: endLineNumber, endColumn: 1
							},
							options: pattern.added ? this.addedPatternOptions : this.addedOptions
						};
					case ChangeType.Delete:
						return {
							range: {
								startLineNumber: startLineNumber, startColumn: Number.MAX_VALUE,
								endLineNumber: startLineNumber, endColumn: Number.MAX_VALUE
							},
							options: this.deletedOptions
						};
					case ChangeType.Modify:
						return {
							range: {
								startLineNumber: startLineNumber, startColumn: 1,
								endLineNumber: endLineNumber, endColumn: 1
							},
							options: pattern.modified ? this.modifiedPatternOptions : this.modifiedOptions
						};
				}
			});

		if (!this.decorationsCollection) {
			this.decorationsCollection = this.codeEditor.createDecorationsCollection(decorations);
		} else {
			this.decorationsCollection.set(decorations);
		}
	}

	override dispose(): void {
		super.dispose();

		if (this.decorationsCollection) {
			this.decorationsCollection?.clear();
		}

		this.editorModel = null;
		this.decorationsCollection = undefined;
	}
}

function compareChanges(a: IChange, b: IChange): number {
	let result = a.modifiedStartLineNumber - b.modifiedStartLineNumber;

	if (result !== 0) {
		return result;
	}

	result = a.modifiedEndLineNumber - b.modifiedEndLineNumber;

	if (result !== 0) {
		return result;
	}

	result = a.originalStartLineNumber - b.originalStartLineNumber;

	if (result !== 0) {
		return result;
	}

	return a.originalEndLineNumber - b.originalEndLineNumber;
}


export async function getOriginalResource(quickDiffService: IQuickDiffService, uri: URI, language: string | undefined, isSynchronized: boolean | undefined): Promise<URI | null> {
	const quickDiffs = await quickDiffService.getQuickDiffs(uri, language, isSynchronized);
	return quickDiffs.length > 0 ? quickDiffs[0].originalResource : null;
}

type LabeledChange = { change: IChange; label: string; uri: URI };

export class DirtyDiffModel extends Disposable {

	private _quickDiffs: QuickDiff[] = [];
	private _originalModels: Map<string, IResolvedTextEditorModel> = new Map(); // key is uri.toString()
	private _originalTextModels: ITextModel[] = [];
	private _model: ITextFileEditorModel;
	get original(): ITextModel[] { return this._originalTextModels; }

	private diffDelayer = new ThrottledDelayer<void>(200);
	private _quickDiffsPromise?: Promise<QuickDiff[]>;
	private repositoryDisposables = new Set<IDisposable>();
	private readonly originalModelDisposables = this._register(new DisposableStore());
	private _disposed = false;

	private readonly _onDidChange = new Emitter<{ changes: LabeledChange[]; diff: ISplice<LabeledChange>[] }>();
	readonly onDidChange: Event<{ changes: LabeledChange[]; diff: ISplice<LabeledChange>[] }> = this._onDidChange.event;

	private _changes: LabeledChange[] = [];
	get changes(): LabeledChange[] { return this._changes; }
	private _mapChanges: Map<string, number[]> = new Map(); // key is the quick diff name, value is the index of the change in this._changes
	get mapChanges(): Map<string, number[]> { return this._mapChanges; }

	constructor(
		textFileModel: IResolvedTextFileEditorModel,
		private readonly algorithm: DiffAlgorithmName | undefined,
		@ISCMService private readonly scmService: ISCMService,
		@IQuickDiffService private readonly quickDiffService: IQuickDiffService,
		@IEditorWorkerService private readonly editorWorkerService: IEditorWorkerService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ITextModelService private readonly textModelResolverService: ITextModelService,
		@IChatEditingService private readonly _chatEditingService: IChatEditingService,
		@IProgressService private readonly progressService: IProgressService,
	) {
		super();
		this._model = textFileModel;

		this._register(textFileModel.textEditorModel.onDidChangeContent(() => this.triggerDiff()));
		this._register(
			Event.filter(configurationService.onDidChangeConfiguration,
				e => e.affectsConfiguration('scm.diffDecorationsIgnoreTrimWhitespace') || e.affectsConfiguration('diffEditor.ignoreTrimWhitespace')
			)(this.triggerDiff, this)
		);
		this._register(scmService.onDidAddRepository(this.onDidAddRepository, this));
		for (const r of scmService.repositories) {
			this.onDidAddRepository(r);
		}

		this._register(this._model.onDidChangeEncoding(() => {
			this.diffDelayer.cancel();
			this._quickDiffs = [];
			this._originalModels.clear();
			this._originalTextModels = [];
			this._quickDiffsPromise = undefined;
			this.setChanges([], new Map());
			this.triggerDiff();
		}));

		this._register(this.quickDiffService.onDidChangeQuickDiffProviders(() => this.triggerDiff()));
		this._register(this._chatEditingService.onDidChangeEditingSession(() => this.triggerDiff()));
		this.triggerDiff();
	}

	get quickDiffs(): readonly QuickDiff[] {
		return this._quickDiffs;
	}

	public getQuickDiffResults(): QuickDiffResult[] {
		return this._quickDiffs.map(quickDiff => {
			const changes = this._changes
				.filter(change => change.label === quickDiff.label)
				.map(change => change.change);

			// Convert IChange[] to LineRangeMapping[]
			const lineRangeMappings = lineRangeMappingFromChanges(changes);
			return {
				original: quickDiff.originalResource,
				modified: this._model.resource,
				changes: lineRangeMappings
			};
		});
	}

	public getDiffEditorModel(originalUri: string): IDiffEditorModel | undefined {
		if (!this._originalModels.has(originalUri)) {
			return;
		}
		const original = this._originalModels.get(originalUri)!;

		return {
			modified: this._model.textEditorModel!,
			original: original.textEditorModel
		};
	}

	private onDidAddRepository(repository: ISCMRepository): void {
		const disposables = new DisposableStore();

		this.repositoryDisposables.add(disposables);
		disposables.add(toDisposable(() => this.repositoryDisposables.delete(disposables)));

		disposables.add(repository.provider.onDidChangeResources(this.triggerDiff, this));

		const onDidRemoveThis = Event.filter(this.scmService.onDidRemoveRepository, r => r === repository);
		disposables.add(onDidRemoveThis(() => dispose(disposables), null));

		this.triggerDiff();
	}

	private triggerDiff(): void {
		if (!this.diffDelayer) {
			return;
		}

		this.diffDelayer
			.trigger(async () => {
				const result: { changes: LabeledChange[]; mapChanges: Map<string, number[]> } | null = await this.diff();

				const originalModels = Array.from(this._originalModels.values());
				if (!result || this._disposed || this._model.isDisposed() || originalModels.some(originalModel => originalModel.isDisposed())) {
					return; // disposed
				}

				if (originalModels.every(originalModel => originalModel.textEditorModel.getValueLength() === 0)) {
					result.changes = [];
				}

				if (!result.changes) {
					result.changes = [];
				}

				this.setChanges(result.changes, result.mapChanges);
			})
			.catch(err => onUnexpectedError(err));
	}

	private setChanges(changes: LabeledChange[], mapChanges: Map<string, number[]>): void {
		const diff = sortedDiff(this._changes, changes, (a, b) => compareChanges(a.change, b.change));
		this._changes = changes;
		this._mapChanges = mapChanges;
		this._onDidChange.fire({ changes, diff });
	}

	private diff(): Promise<{ changes: LabeledChange[]; mapChanges: Map<string, number[]> } | null> {
		return this.progressService.withProgress({ location: ProgressLocation.Scm, delay: 250 }, async () => {
			const originalURIs = await this.getQuickDiffsPromise();
			if (this._disposed || this._model.isDisposed() || (originalURIs.length === 0)) {
				return Promise.resolve({ changes: [], mapChanges: new Map() }); // disposed
			}

			const filteredToDiffable = originalURIs.filter(quickDiff => this.editorWorkerService.canComputeDirtyDiff(quickDiff.originalResource, this._model.resource));
			if (filteredToDiffable.length === 0) {
				return Promise.resolve({ changes: [], mapChanges: new Map() }); // All files are too large
			}

			const ignoreTrimWhitespaceSetting = this.configurationService.getValue<'true' | 'false' | 'inherit'>('scm.diffDecorationsIgnoreTrimWhitespace');
			const ignoreTrimWhitespace = ignoreTrimWhitespaceSetting === 'inherit'
				? this.configurationService.getValue<boolean>('diffEditor.ignoreTrimWhitespace')
				: ignoreTrimWhitespaceSetting !== 'false';

			const allDiffs: LabeledChange[] = [];
			for (const quickDiff of filteredToDiffable) {
				const dirtyDiff = await this._diff(quickDiff.originalResource, this._model.resource, ignoreTrimWhitespace);
				if (dirtyDiff) {
					for (const diff of dirtyDiff) {
						if (diff) {
							allDiffs.push({ change: diff, label: quickDiff.label, uri: quickDiff.originalResource });
						}
					}
				}
			}
			const sorted = allDiffs.sort((a, b) => compareChanges(a.change, b.change));
			const map: Map<string, number[]> = new Map();
			for (let i = 0; i < sorted.length; i++) {
				const label = sorted[i].label;
				if (!map.has(label)) {
					map.set(label, []);
				}
				map.get(label)!.push(i);
			}
			return { changes: sorted, mapChanges: map };
		});
	}

	private async _diff(original: URI, modified: URI, ignoreTrimWhitespace: boolean): Promise<IChange[] | null> {
		if (this.algorithm === undefined) {
			return this.editorWorkerService.computeDirtyDiff(original, modified, ignoreTrimWhitespace);
		}

		const diffResult = await this.editorWorkerService.computeDiff(original, modified, {
			computeMoves: false,
			ignoreTrimWhitespace,
			maxComputationTimeMs: Number.MAX_SAFE_INTEGER
		}, this.algorithm);

		if (!diffResult) {
			return null;
		}

		return toLineChanges(DiffState.fromDiffResult(diffResult));
	}

	private getQuickDiffsPromise(): Promise<QuickDiff[]> {
		if (this._quickDiffsPromise) {
			return this._quickDiffsPromise;
		}

		this._quickDiffsPromise = this.getOriginalResource().then(async (quickDiffs) => {
			if (this._disposed) { // disposed
				return [];
			}

			if (quickDiffs.length === 0) {
				this._quickDiffs = [];
				this._originalModels.clear();
				this._originalTextModels = [];
				return [];
			}

			if (equals(this._quickDiffs, quickDiffs, (a, b) => a.originalResource.toString() === b.originalResource.toString() && a.label === b.label)) {
				return quickDiffs;
			}

			this.originalModelDisposables.clear();
			this._originalModels.clear();
			this._originalTextModels = [];
			this._quickDiffs = quickDiffs;
			return (await Promise.all(quickDiffs.map(async (quickDiff) => {
				try {
					const ref = await this.textModelResolverService.createModelReference(quickDiff.originalResource);
					if (this._disposed) { // disposed
						ref.dispose();
						return [];
					}

					this._originalModels.set(quickDiff.originalResource.toString(), ref.object);
					this._originalTextModels.push(ref.object.textEditorModel);

					if (isTextFileEditorModel(ref.object)) {
						const encoding = this._model.getEncoding();

						if (encoding) {
							ref.object.setEncoding(encoding, EncodingMode.Decode);
						}
					}

					this.originalModelDisposables.add(ref);
					this.originalModelDisposables.add(ref.object.textEditorModel.onDidChangeContent(() => this.triggerDiff()));

					return quickDiff;
				} catch (error) {
					return []; // possibly invalid reference
				}
			}))).flat();
		});

		return this._quickDiffsPromise.finally(() => {
			this._quickDiffsPromise = undefined;
		});
	}

	private async getOriginalResource(): Promise<QuickDiff[]> {
		if (this._disposed) {
			return Promise.resolve([]);
		}
		const uri = this._model.resource;

		const session = this._chatEditingService.currentEditingSession;
		if (session && session.getEntry(uri)?.state.get() === WorkingSetEntryState.Modified) {
			// disable dirty diff when doing chat edits
			return Promise.resolve([]);
		}

		const isSynchronized = this._model.textEditorModel ? shouldSynchronizeModel(this._model.textEditorModel) : undefined;
		const quickDiffs = await this.quickDiffService.getQuickDiffs(uri, this._model.getLanguageId(), isSynchronized);

		// TODO@lszomoru - find a long term solution for this
		// When the DirtyDiffModel is created for a diff editor, there is no
		// need to compute the diff information for the `isSCM` quick diff
		// provider as that information will be provided by the diff editor
		return this.algorithm !== undefined
			? quickDiffs.filter(quickDiff => !quickDiff.isSCM)
			: quickDiffs;
	}

	findNextClosestChange(lineNumber: number, inclusive = true, provider?: string): number {
		let preferredProvider: string | undefined;
		if (!provider && inclusive) {
			preferredProvider = this.quickDiffs.find(value => value.isSCM)?.label;
		}

		const possibleChanges: number[] = [];
		for (let i = 0; i < this.changes.length; i++) {
			if (provider && this.changes[i].label !== provider) {
				continue;
			}
			const change = this.changes[i];
			const possibleChangesLength = possibleChanges.length;

			if (inclusive) {
				if (getModifiedEndLineNumber(change.change) >= lineNumber) {
					if (preferredProvider && change.label !== preferredProvider) {
						possibleChanges.push(i);
					} else {
						return i;
					}
				}
			} else {
				if (change.change.modifiedStartLineNumber > lineNumber) {
					return i;
				}
			}
			if ((possibleChanges.length > 0) && (possibleChanges.length === possibleChangesLength)) {
				return possibleChanges[0];
			}
		}

		return possibleChanges.length > 0 ? possibleChanges[0] : 0;
	}

	findPreviousClosestChange(lineNumber: number, inclusive = true, provider?: string): number {
		for (let i = this.changes.length - 1; i >= 0; i--) {
			if (provider && this.changes[i].label !== provider) {
				continue;
			}
			const change = this.changes[i].change;

			if (inclusive) {
				if (change.modifiedStartLineNumber <= lineNumber) {
					return i;
				}
			} else {
				if (getModifiedEndLineNumber(change) < lineNumber) {
					return i;
				}
			}
		}

		return this.changes.length - 1;
	}

	override dispose(): void {
		super.dispose();

		this._disposed = true;
		this._quickDiffs = [];
		this._originalModels.clear();
		this._originalTextModels = [];
		this.diffDelayer.cancel();
		this.repositoryDisposables.forEach(d => dispose(d));
		this.repositoryDisposables.clear();
	}
}

class DirtyDiffItem {

	constructor(
		readonly model: DirtyDiffModel,
		readonly decorator: DirtyDiffDecorator
	) { }

	dispose(): void {
		this.decorator.dispose();
		this.model.dispose();
	}
}

interface IViewState {
	readonly width: number;
	readonly visibility: 'always' | 'hover';
}

export class DirtyDiffWorkbenchController extends Disposable implements ext.IWorkbenchContribution, IModelRegistry {

	private enabled = false;
	private viewState: IViewState = { width: 3, visibility: 'always' };
	private items = new ResourceMap<Map<string, DirtyDiffItem>>(); // resource -> editor id -> DirtyDiffItem
	private readonly transientDisposables = this._register(new DisposableStore());
	private stylesheet: HTMLStyleElement;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ITextFileService private readonly textFileService: ITextFileService
	) {
		super();
		this.stylesheet = domStylesheetsJs.createStyleSheet(undefined, undefined, this._store);

		const onDidChangeConfiguration = Event.filter(configurationService.onDidChangeConfiguration, e => e.affectsConfiguration('scm.diffDecorations'));
		this._register(onDidChangeConfiguration(this.onDidChangeConfiguration, this));
		this.onDidChangeConfiguration();

		const onDidChangeDiffWidthConfiguration = Event.filter(configurationService.onDidChangeConfiguration, e => e.affectsConfiguration('scm.diffDecorationsGutterWidth'));
		this._register(onDidChangeDiffWidthConfiguration(this.onDidChangeDiffWidthConfiguration, this));
		this.onDidChangeDiffWidthConfiguration();

		const onDidChangeDiffVisibilityConfiguration = Event.filter(configurationService.onDidChangeConfiguration, e => e.affectsConfiguration('scm.diffDecorationsGutterVisibility'));
		this._register(onDidChangeDiffVisibilityConfiguration(this.onDidChangeDiffVisibilityConfiguration, this));
		this.onDidChangeDiffVisibilityConfiguration();
	}

	private onDidChangeConfiguration(): void {
		const enabled = this.configurationService.getValue<string>('scm.diffDecorations') !== 'none';

		if (enabled) {
			this.enable();
		} else {
			this.disable();
		}
	}

	private onDidChangeDiffWidthConfiguration(): void {
		let width = this.configurationService.getValue<number>('scm.diffDecorationsGutterWidth');

		if (isNaN(width) || width <= 0 || width > 5) {
			width = 3;
		}

		this.setViewState({ ...this.viewState, width });
	}

	private onDidChangeDiffVisibilityConfiguration(): void {
		const visibility = this.configurationService.getValue<'always' | 'hover'>('scm.diffDecorationsGutterVisibility');
		this.setViewState({ ...this.viewState, visibility });
	}

	private setViewState(state: IViewState): void {
		this.viewState = state;
		this.stylesheet.textContent = `
			.monaco-editor .dirty-diff-added,
			.monaco-editor .dirty-diff-modified {
				border-left-width:${state.width}px;
			}
			.monaco-editor .dirty-diff-added-pattern,
			.monaco-editor .dirty-diff-added-pattern:before,
			.monaco-editor .dirty-diff-modified-pattern,
			.monaco-editor .dirty-diff-modified-pattern:before {
				background-size: ${state.width}px ${state.width}px;
			}
			.monaco-editor .dirty-diff-added,
			.monaco-editor .dirty-diff-added-pattern,
			.monaco-editor .dirty-diff-modified,
			.monaco-editor .dirty-diff-modified-pattern,
			.monaco-editor .dirty-diff-deleted {
				opacity: ${state.visibility === 'always' ? 1 : 0};
			}
		`;
	}

	private enable(): void {
		if (this.enabled) {
			this.disable();
		}

		this.transientDisposables.add(Event.any(this.editorService.onDidCloseEditor, this.editorService.onDidVisibleEditorsChange)(() => this.onEditorsChanged()));
		this.onEditorsChanged();
		this.enabled = true;
	}

	private disable(): void {
		if (!this.enabled) {
			return;
		}

		this.transientDisposables.clear();

		for (const [, dirtyDiff] of this.items) {
			dispose(dirtyDiff.values());
		}

		this.items.clear();
		this.enabled = false;
	}

	private onEditorsChanged(): void {
		for (const editor of this.editorService.visibleTextEditorControls) {
			if (isCodeEditor(editor)) {
				const textModel = editor.getModel();
				const controller = DirtyDiffController.get(editor);

				if (controller) {
					controller.modelRegistry = this;
				}

				if (textModel && (!this.items.has(textModel.uri) || !this.items.get(textModel.uri)!.has(editor.getId()))) {
					const textFileModel = this.textFileService.files.get(textModel.uri);

					if (textFileModel?.isResolved()) {
						const dirtyDiffModel = this.instantiationService.createInstance(DirtyDiffModel, textFileModel, undefined);
						const decorator = new DirtyDiffDecorator(textFileModel.textEditorModel, editor, dirtyDiffModel, this.configurationService);
						if (!this.items.has(textModel.uri)) {
							this.items.set(textModel.uri, new Map());
						}
						this.items.get(textModel.uri)?.set(editor.getId(), new DirtyDiffItem(dirtyDiffModel, decorator));
					}
				}
			}
		}

		for (const [uri, item] of this.items) {
			for (const editorId of item.keys()) {
				if (!this.editorService.visibleTextEditorControls.find(editor => isCodeEditor(editor) && editor.getModel()?.uri.toString() === uri.toString() && editor.getId() === editorId)) {
					if (item.has(editorId)) {
						const dirtyDiffItem = item.get(editorId);
						dirtyDiffItem?.dispose();
						item.delete(editorId);
						if (item.size === 0) {
							this.items.delete(uri);
						}
					}
				}
			}
		}
	}

	getModel(editorModel: ITextModel, codeEditor: ICodeEditor): DirtyDiffModel | undefined {
		return this.items.get(editorModel.uri)?.get(codeEditor.getId())?.model;
	}

	override dispose(): void {
		this.disable();
		super.dispose();
	}
}

registerEditorContribution(DirtyDiffController.ID, DirtyDiffController, EditorContributionInstantiation.AfterFirstRender);
