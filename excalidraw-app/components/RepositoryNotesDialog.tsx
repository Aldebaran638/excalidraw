import { useEffect, useMemo, useRef, useState } from "react";

import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  file,
  LoadIcon,
  save,
  saveAs,
  searchIcon,
} from "@excalidraw/excalidraw/components/icons";

import {
  listRepositoryNotes,
  normalizeRepositoryNoteName,
} from "../data/repositoryNotes";

import "./RepositoryNotesDialog.scss";

type RepositoryDialogMode = "save" | "saveAs" | "open";

const withoutExtension = (name?: string | null) =>
  name?.replace(/\.excalidraw$/i, "") || "note";

export const RepositoryNotesDialog = (props: {
  mode: RepositoryDialogMode;
  initialName?: string | null;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
  onOpen: (name: string) => Promise<void>;
}) => {
  const [name, setName] = useState(withoutExtension(props.initialName));
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [selectedNote, setSelectedNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const isSaving = props.mode !== "open";

  useEffect(() => {
    listRepositoryNotes()
      .then(setNotes)
      .catch((err) => setError(err.message));
    if (isSaving) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [isSaving]);

  const filteredNotes = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return normalizedQuery
      ? notes.filter((note) => note.toLowerCase().includes(normalizedQuery))
      : notes;
  }, [notes, query]);

  const destinationName = name.trim() ? normalizeRepositoryNoteName(name) : "";
  const existingDestination = notes.find(
    (note) => note.toLowerCase() === destinationName.toLowerCase(),
  );

  const saveNote = async () => {
    if (!destinationName) {
      setError("Enter a file name or select an existing note");
      return;
    }
    setError(null);
    setIsLoading(true);
    try {
      await props.onSave(existingDestination || destinationName);
      props.onClose();
    } catch (err: any) {
      setError(err.message || "Unable to save repository note");
    } finally {
      setIsLoading(false);
    }
  };

  const openNote = async (note: string) => {
    setError(null);
    setIsLoading(true);
    try {
      await props.onOpen(note);
      props.onClose();
    } catch (err: any) {
      setError(err.message || "Unable to open repository note");
    } finally {
      setIsLoading(false);
    }
  };

  const chooseSaveDestination = (note: string) => {
    setSelectedNote(note);
    setName(withoutExtension(note));
    setError(null);
  };

  const title =
    props.mode === "open"
      ? "Open repository note"
      : props.mode === "saveAs"
      ? "Save repository note as"
      : "Choose repository save destination";

  return (
    <Dialog
      className="RepositoryNotesDialog"
      title={title}
      onCloseRequest={props.onClose}
      size={isSaving ? "regular" : "small"}
    >
      <div className="RepositoryNotesDialog__content">
        <div className="RepositoryNotesDialog__location">
          <span className="RepositoryNotesDialog__locationIcon">
            {LoadIcon}
          </span>
          <span>notes</span>
          <span className="RepositoryNotesDialog__separator">/</span>
          <span className="RepositoryNotesDialog__muted">
            {isSaving ? "choose a file to bind" : "repository files"}
          </span>
        </div>

        {isSaving && (
          <form
            className="RepositoryNotesDialog__save"
            onSubmit={(event) => {
              event.preventDefault();
              void saveNote();
            }}
          >
            <TextField
              ref={nameInputRef}
              label="File name"
              value={name}
              onChange={(value) => {
                setName(value);
                setSelectedNote(null);
              }}
              placeholder="note"
              fullWidth
            />
            <div className="RepositoryNotesDialog__destinationStatus">
              <span>
                {existingDestination
                  ? `This will overwrite and bind ${existingDestination}`
                  : destinationName
                  ? `This will create and bind ${destinationName}`
                  : "Enter a new name or choose an existing note below"}
              </span>
              <code>.excalidraw</code>
            </div>
          </form>
        )}

        <div className="RepositoryNotesDialog__browser">
          {isSaving && (
            <div className="RepositoryNotesDialog__divider">
              <span>or choose an existing note</span>
            </div>
          )}
          <TextField
            icon={searchIcon}
            value={query}
            onChange={setQuery}
            placeholder="Search notes"
            fullWidth
            type="search"
          />
          <div
            className="RepositoryNotesDialog__list"
            role="listbox"
            aria-label="Repository notes"
          >
            {filteredNotes.map((note) => {
              const isSelected = isSaving && selectedNote === note;
              return (
                <button
                  key={note}
                  className={`RepositoryNotesDialog__note${
                    isSelected ? " RepositoryNotesDialog__note--selected" : ""
                  }`}
                  type="button"
                  onClick={() =>
                    isSaving ? chooseSaveDestination(note) : void openNote(note)
                  }
                  disabled={isLoading}
                  aria-pressed={isSelected}
                >
                  <span className="RepositoryNotesDialog__noteIcon">
                    {file}
                  </span>
                  <span className="RepositoryNotesDialog__noteName">
                    {note}
                  </span>
                  <span className="RepositoryNotesDialog__noteArrow">
                    {isSelected ? "✓" : "→"}
                  </span>
                </button>
              );
            })}
            {!error && filteredNotes.length === 0 && (
              <div className="RepositoryNotesDialog__empty">
                <span className="RepositoryNotesDialog__emptyIcon">{file}</span>
                <strong>
                  {notes.length
                    ? "No matching notes"
                    : "No repository notes yet"}
                </strong>
                <span>
                  {notes.length
                    ? "Try a different search."
                    : isSaving
                    ? "Enter a name above to create the first note."
                    : "Save your current canvas to create one."}
                </span>
              </div>
            )}
          </div>
        </div>

        {error && (
          <p className="RepositoryNotesDialog__error" role="alert">
            {error}
          </p>
        )}

        {isSaving && (
          <div className="RepositoryNotesDialog__actions">
            <FilledButton
              label="Cancel"
              variant="outlined"
              color="muted"
              onClick={props.onClose}
            />
            <FilledButton
              label={
                existingDestination ? "Overwrite and bind" : "Save and bind"
              }
              icon={props.mode === "saveAs" ? saveAs : save}
              onClick={() => void saveNote()}
              status={isLoading ? "loading" : null}
              disabled={!destinationName}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
};
