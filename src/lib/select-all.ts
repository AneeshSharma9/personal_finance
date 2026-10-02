/**
 * Select a field's whole contents when it is focused or clicked.
 *
 * Applied across the app's numeric and short-identifier fields - the ones you
 * arrive intending to overwrite rather than edit. Two handlers, because neither
 * covers the other:
 *
 *  - `onFocus` covers arriving by keyboard. Tabbing in never fires a click, and
 *    without it the first keystroke lands in the middle of the existing number.
 *  - `onClick` covers arriving by mouse. `onFocus` alone fires only when a field
 *    *gains* focus, so clicking a field that already has it just moves the caret.
 *    These inputs are right-aligned, so clicking the empty space to the left of
 *    the digits did exactly that - which made select-all look intermittent: the
 *    first click worked and the next one undid it.
 *
 * `onClick` rather than `onMouseDown` deliberately: selecting on mousedown gets
 * undone by the browser's own caret placement on mouseup.
 *
 * ## Deliberately not applied
 *
 * - **The transaction search box and the category filter.** Free text you edit in
 *   place - clicking to put a caret after part of a query is the normal gesture
 *   there, and select-all would fight it.
 * - **Passwords.** Selecting one reveals its length, which is a habit worth not
 *   building in.
 * - **The login email field.** Typed fresh each time, and a login form is the
 *   wrong place to be surprising someone.
 */
type SelectableField = { currentTarget: HTMLInputElement };

export function selectAll(event: SelectableField): void {
  event.currentTarget.select();
}

/**
 * Spread onto an input to get both behaviours.
 *
 * `onFocus` and `onClick` have different React event types, so these are typed
 * structurally rather than as React events - one function satisfies both.
 */
export const selectAllProps = {
  onFocus: selectAll,
  onClick: selectAll,
} as const;