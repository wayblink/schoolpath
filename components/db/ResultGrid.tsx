"use client";

import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { renderCell } from "@/components/db/types";

interface Props {
  columns: string[];
  rows: unknown[][];
  /** Column currently used for ordering (header gets an indicator). */
  orderBy?: string | null;
  orderDir?: "asc" | "desc";
  /** When set, headers become clickable to toggle ordering. */
  onSort?: (column: string) => void;
  /** Columns that belong to the primary key (rendered with accent). */
  pkColumns?: string[];
  emptyHint?: string;
  /** When provided, a trailing "操作" column renders these per-row controls. */
  renderRowActions?: (row: unknown[], rowIndex: number) => React.ReactNode;
  /** When provided, a per-column filter input row renders under the headers. */
  columnFilters?: Record<string, string>;
  onColumnFilterChange?: (column: string, value: string) => void;
  /** When provided, a leading checkbox column enables row selection. */
  rowKey?: (row: unknown[], rowIndex: number) => string;
  selectedKeys?: Set<string>;
  onToggleRow?: (key: string, row: unknown[]) => void;
  onToggleAll?: (select: boolean) => void;
  /** Columns whose cells can be edited inline (click to edit). */
  editableColumns?: Set<string>;
  /** Persist an inline cell edit; reject to surface an error in the cell. */
  onCellEdit?: (row: unknown[], column: string, newValue: string) => Promise<void>;
}

type EditingCell = { rowIdx: number; col: string; original: string };

export function ResultGrid({
  columns,
  rows,
  orderBy,
  orderDir,
  onSort,
  pkColumns,
  emptyHint = "无数据",
  renderRowActions,
  columnFilters,
  onColumnFilterChange,
  rowKey,
  selectedKeys,
  onToggleRow,
  onToggleAll,
  editableColumns,
  onCellEdit,
}: Props) {
  const pk = new Set(pkColumns ?? []);
  const selectable = Boolean(rowKey && onToggleRow);
  const pageKeys = selectable ? rows.map((row, i) => rowKey!(row, i)) : [];
  const allSelected = selectable && pageKeys.length > 0 && pageKeys.every((k) => selectedKeys?.has(k));
  const someSelected = selectable && pageKeys.some((k) => selectedKeys?.has(k));

  const canEdit = (col: string) => Boolean(onCellEdit && editableColumns?.has(col));

  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [cellError, setCellError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const startEdit = (rowIdx: number, col: string, current: string) => {
    if (saving) return;
    cancelRef.current = false;
    setCellError(null);
    setEditing({ rowIdx, col, original: current });
    setDraft(current);
  };

  const finishEdit = async () => {
    if (!editing || saving) return;
    if (cancelRef.current) {
      setEditing(null);
      return;
    }
    if (draft === editing.original) {
      setEditing(null);
      return;
    }
    setSaving(true);
    try {
      await onCellEdit!(rows[editing.rowIdx], editing.col, draft);
      setEditing(null);
      setCellError(null);
    } catch (err) {
      setCellError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (columns.length === 0) {
    return (
      <div className="grid h-full place-items-center p-8 text-[13px] text-[var(--color-text-muted)]">
        {emptyHint}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 z-10 bg-[var(--color-section-label-bg)] text-[var(--color-text-dim)]">
          <tr>
            {selectable && (
              <th className="border-b border-[var(--color-panel-border)] px-2 py-1.5 text-center">
                <input
                  type="checkbox"
                  aria-label="全选当前页"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = !allSelected && someSelected;
                  }}
                  onChange={(e) => onToggleAll?.(e.target.checked)}
                  className="cursor-pointer accent-[var(--color-accent)]"
                />
              </th>
            )}
            <th className="border-b border-[var(--color-panel-border)] px-2 py-1.5 text-right font-mono-tiny font-normal text-[var(--color-text-muted)]">
              #
            </th>
            {columns.map((col) => {
              const active = orderBy === col;
              return (
                <th
                  key={col}
                  onClick={onSort ? () => onSort(col) : undefined}
                  className={cn(
                    "border-b border-[var(--color-panel-border)] px-2.5 py-1.5 text-left font-medium whitespace-nowrap",
                    onSort && "group cursor-pointer select-none hover:text-[var(--color-text)]",
                    pk.has(col) && "text-[var(--color-accent)]",
                  )}
                  title={pk.has(col) ? `${col}（主键）` : col}
                >
                  <span className="inline-flex items-center gap-1">
                    {col}
                    {onSort &&
                      (active ? (
                        orderDir === "desc" ? (
                          <ArrowDown size={12} className="text-[var(--color-accent)]" aria-label="降序" />
                        ) : (
                          <ArrowUp size={12} className="text-[var(--color-accent)]" aria-label="升序" />
                        )
                      ) : (
                        <ChevronsUpDown
                          size={12}
                          className="text-[var(--color-text-muted)] opacity-40 group-hover:opacity-70"
                          aria-hidden
                        />
                      ))}
                  </span>
                </th>
              );
            })}
            {renderRowActions && (
              <th className="sticky right-0 border-b border-l border-[var(--color-panel-border)] bg-[var(--color-section-label-bg)] px-2.5 py-1.5 text-right font-medium">
                操作
              </th>
            )}
          </tr>
          {onColumnFilterChange && (
            <tr>
              {selectable && (
                <th className="border-b border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-0" />
              )}
              <th className="border-b border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-0" />
              {columns.map((col) => (
                <th
                  key={col}
                  className="border-b border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-1.5 py-1"
                >
                  <input
                    value={columnFilters?.[col] ?? ""}
                    onChange={(e) => onColumnFilterChange(col, e.target.value)}
                    placeholder="筛选…"
                    className="h-6 w-full min-w-[80px] rounded border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-1.5 font-mono-tiny text-[11px] font-normal text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-card-hover-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-selected-ring)]"
                  />
                </th>
              ))}
              {renderRowActions && (
                <th className="sticky right-0 border-b border-l border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] p-0" />
              )}
            </tr>
          )}
        </thead>
        <tbody>
          {rows.map((row, rowIdx) => {
            const key = selectable ? pageKeys[rowIdx] : "";
            const selected = selectable && selectedKeys?.has(key);
            return (
              <tr
                key={rowIdx}
                className={cn(
                  "border-b border-[var(--color-panel-border)]/50 hover:bg-[var(--color-list-row-hover)]",
                  selected && "bg-[var(--color-list-row-selected)]",
                )}
              >
                {selectable && (
                  <td className="px-2 py-1 text-center">
                    <input
                      type="checkbox"
                      aria-label="选择该行"
                      checked={selected}
                      onChange={() => onToggleRow!(key, row)}
                      className="cursor-pointer accent-[var(--color-accent)]"
                    />
                  </td>
                )}
                <td className="px-2 py-1 text-right font-mono-tiny text-[var(--color-text-muted)]">
                  {rowIdx + 1}
                </td>
                {row.map((cell, cellIdx) => {
                  const col = columns[cellIdx];
                  const text = renderCell(cell);
                  const isNull = cell === null || cell === undefined;
                  const editable = canEdit(col);
                  const isEditing = editing?.rowIdx === rowIdx && editing?.col === col;

                  if (isEditing) {
                    const hasError = Boolean(cellError);
                    return (
                      <td key={cellIdx} className="px-1 py-0.5">
                        <input
                          autoFocus
                          value={draft}
                          disabled={saving}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              e.currentTarget.blur();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              cancelRef.current = true;
                              e.currentTarget.blur();
                            }
                          }}
                          onBlur={finishEdit}
                          title={hasError ? cellError! : undefined}
                          className={cn(
                            "h-6 w-full min-w-[80px] rounded border bg-[var(--color-control-bg)] px-1.5 font-mono-tiny text-[12px] text-[var(--color-text)] focus:outline-none focus:ring-1",
                            hasError
                              ? "border-[var(--color-danger)] focus:ring-[var(--color-danger)]"
                              : "border-[var(--color-card-hover-border)] focus:ring-[var(--color-selected-ring)]",
                          )}
                        />
                      </td>
                    );
                  }

                  return (
                    <td
                      key={cellIdx}
                      onClick={editable ? () => startEdit(rowIdx, col, isNull ? "" : text) : undefined}
                      className={cn(
                        "max-w-[420px] truncate px-2.5 py-1 font-mono-tiny",
                        isNull ? "text-[var(--color-text-muted)] italic" : "text-[var(--color-text)]",
                        editable &&
                          "cursor-text hover:bg-[var(--color-control-hover)] hover:ring-1 hover:ring-inset hover:ring-[var(--color-card-hover-border)]",
                      )}
                      title={editable ? `点击编辑 · ${isNull ? "NULL" : text}` : isNull ? "NULL" : text}
                    >
                      {isNull ? "NULL" : text}
                    </td>
                  );
                })}
                {renderRowActions && (
                  <td className="sticky right-0 border-l border-[var(--color-panel-border)]/50 bg-[var(--color-panel-bg)] px-2 py-1 text-right">
                    {renderRowActions(row, rowIdx)}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
