package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func newTestApp(t *testing.T) *App {
	t.Helper()
	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { app.Close() })
	return app
}

func performJSONRequest(t *testing.T, handler http.Handler, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(payload)
	}
	request := httptest.NewRequest(method, target, reader)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeResponse[T any](t *testing.T, response *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
		t.Fatalf("decode response %q: %v", response.Body.String(), err)
	}
	return value
}

func TestGraphBacklinksAndOccurrenceHandlers(t *testing.T) {
	app := newTestApp(t)
	handler := app.Handler(filepath.Join("..", "web", "frontend"))

	targetID, err := app.CreateNote(Note{Title: "Alvo", Folder: "Notas"})
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := app.CreateNote(Note{
		Title:   "Fonte",
		Folder:  "Notas",
		Content: "[[Alvo]] e [[Alvo|alias]] e alvo no texto",
	})
	if err != nil {
		t.Fatal(err)
	}

	response := performJSONRequest(t, handler, http.MethodGet, "/api/graph", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("graph status = %d, body = %s", response.Code, response.Body.String())
	}
	graph := decodeResponse[NoteGraph](t, response)
	foundEdge := false
	for _, edge := range graph.Edges {
		if edge.Source == sourceID && edge.Target == targetID {
			foundEdge = true
		}
	}
	if !foundEdge {
		t.Fatalf("graph is missing the source -> target edge: %#v", graph.Edges)
	}

	response = performJSONRequest(t, handler, http.MethodGet,
		fmt.Sprintf("/api/notes/%d/backlinks", targetID), nil)
	if response.Code != http.StatusOK {
		t.Fatalf("backlinks status = %d, body = %s", response.Code, response.Body.String())
	}
	backlinks := decodeResponse[[]NoteSummary](t, response)
	if len(backlinks) != 1 || backlinks[0].ID != sourceID {
		t.Fatalf("unexpected backlinks: %#v", backlinks)
	}

	response = performJSONRequest(t, handler, http.MethodGet,
		fmt.Sprintf("/api/notes/%d/occurrences?q=alvo", sourceID), nil)
	if response.Code != http.StatusOK {
		t.Fatalf("occurrences status = %d, body = %s", response.Code, response.Body.String())
	}
	occurrences := decodeResponse[struct {
		Snippets    []string `json:"snippets"`
		Occurrences int      `json:"occurrences"`
	}](t, response)
	if occurrences.Occurrences < 3 {
		t.Fatalf("occurrences = %d, want at least 3", occurrences.Occurrences)
	}
	if len(occurrences.Snippets) == 0 {
		t.Fatalf("occurrences response has no snippets: %#v", occurrences)
	}

	response = performJSONRequest(t, handler, http.MethodGet,
		fmt.Sprintf("/api/notes/%d/occurrences", sourceID), nil)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("missing query status = %d, want 400", response.Code)
	}

	response = performJSONRequest(t, handler, http.MethodPost, "/api/graph", nil)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("graph POST status = %d, want 405", response.Code)
	}
}

func TestFolderRenameAndAttachmentListHandlers(t *testing.T) {
	app := newTestApp(t)
	handler := app.Handler(filepath.Join("..", "web", "frontend"))

	noteID, err := app.CreateNote(Note{Title: "Relatório", Folder: "Antiga/Sub"})
	if err != nil {
		t.Fatal(err)
	}
	attachment, err := app.SaveAttachment(noteID, strings.NewReader("conteúdo"), "nota.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, attachmentPath, err := app.GetAttachment(noteID, attachment.ID)
	if err != nil {
		t.Fatal(err)
	}

	response := performJSONRequest(t, handler, http.MethodPost, "/api/folders/rename",
		map[string]string{"source": "Antiga", "name": "Nova"})
	if response.Code != http.StatusOK {
		t.Fatalf("folder rename status = %d, body = %s", response.Code, response.Body.String())
	}
	note, err := app.GetNote(noteID)
	if err != nil {
		t.Fatal(err)
	}
	if note.Folder != "Nova/Sub" {
		t.Fatalf("folder after rename = %q, want Nova/Sub", note.Folder)
	}

	response = performJSONRequest(t, handler, http.MethodGet,
		fmt.Sprintf("/api/notes/%d/attachments", noteID), nil)
	if response.Code != http.StatusOK {
		t.Fatalf("attachment list status = %d, body = %s", response.Code, response.Body.String())
	}
	items := decodeResponse[[]Attachment](t, response)
	if len(items) != 1 || items[0].Filename != "nota.txt" || items[0].URL != attachmentURL(noteID, attachment.ID) {
		t.Fatalf("unexpected attachment list: %#v", items)
	}

	response = performJSONRequest(t, handler, http.MethodDelete,
		fmt.Sprintf("/api/notes/%d/attachments/%d", noteID, attachment.ID), nil)
	if response.Code != http.StatusNoContent {
		t.Fatalf("attachment delete status = %d, body = %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(attachmentPath); !os.IsNotExist(err) {
		t.Fatalf("attachment file survived deletion: %v", err)
	}

	response = performJSONRequest(t, handler, http.MethodPost, "/api/folders/rename",
		map[string]string{"source": "Nova", "name": "com/barra"})
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid rename status = %d, want 400", response.Code)
	}
}

func TestDeleteFolderMovesNotesToRoot(t *testing.T) {
	app := newTestApp(t)
	handler := app.Handler(filepath.Join("..", "web", "frontend"))

	insideID, err := app.CreateNote(Note{Title: "Dentro", Folder: "Projetos"})
	if err != nil {
		t.Fatal(err)
	}
	nestedID, err := app.CreateNote(Note{Title: "Aninhada", Folder: "Projetos/Ideias"})
	if err != nil {
		t.Fatal(err)
	}
	outsideID, err := app.CreateNote(Note{Title: "Fora", Folder: "Projetos antigos"})
	if err != nil {
		t.Fatal(err)
	}
	if err := app.CreateFolder("Projetos/Vazia"); err != nil {
		t.Fatal(err)
	}

	response := performJSONRequest(t, handler, http.MethodPost, "/api/folders/delete",
		map[string]string{"path": "Projetos"})
	if response.Code != http.StatusOK {
		t.Fatalf("folder delete status = %d, body = %s", response.Code, response.Body.String())
	}
	result := decodeResponse[map[string]int64](t, response)
	if result["moved"] != 2 {
		t.Fatalf("moved count = %d, want 2", result["moved"])
	}

	for _, id := range []int64{insideID, nestedID} {
		note, err := app.GetNote(id)
		if err != nil {
			t.Fatal(err)
		}
		if note.Folder != "" {
			t.Fatalf("note %d folder = %q, want root", id, note.Folder)
		}
	}
	outside, err := app.GetNote(outsideID)
	if err != nil {
		t.Fatal(err)
	}
	if outside.Folder != "Projetos antigos" {
		t.Fatalf("unrelated note folder = %q, want Projetos antigos", outside.Folder)
	}
	folders, err := app.FolderTree()
	if err != nil {
		t.Fatal(err)
	}
	for _, folder := range folders {
		if folder.Path == "Projetos" {
			t.Fatalf("deleted folder remains in tree: %#v", folders)
		}
	}

	response = performJSONRequest(t, handler, http.MethodPost, "/api/folders/delete",
		map[string]string{"path": "Projetos"})
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing folder delete status = %d, want 404", response.Code)
	}
}

func TestRestoreBackupIsConsistentWithConcurrentUploads(t *testing.T) {
	app := newTestApp(t)
	noteID, err := app.CreateNote(Note{Title: "Alvo", Folder: "Notas"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.SaveAttachment(noteID, strings.NewReader("original"), "original.txt"); err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	if err := app.ExportBackup(&archive); err != nil {
		t.Fatal(err)
	}

	// A note created after the export must be removed by the restore.
	staleID, err := app.CreateNote(Note{Title: "Stale"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.SaveAttachment(staleID, strings.NewReader("stale"), "stale.txt"); err != nil {
		t.Fatal(err)
	}

	const workers = 8
	const uploadsPerWorker = 25
	start := make(chan struct{})
	errs := make(chan error, workers*uploadsPerWorker)
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			<-start
			for upload := 0; upload < uploadsPerWorker; upload++ {
				filename := fmt.Sprintf("upload-%d-%d.txt", worker, upload)
				if _, err := app.SaveAttachment(noteID, strings.NewReader(filename), filename); err != nil {
					errs <- err
					return
				}
			}
		}(worker)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-start
		if _, _, err := app.RestoreBackup(archive.Bytes()); err != nil {
			errs <- err
		}
	}()
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent operation failed: %v", err)
	}

	page, err := app.ListNotes("", "", 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || page.Items[0].ID != noteID {
		t.Fatalf("unexpected notes after restore: %#v", page)
	}
	assertAttachmentStorageConsistent(t, app)
}

// assertAttachmentStorageConsistent verifies that every attachment row points
// to an existing file and that no unreferenced files are left behind.
func assertAttachmentStorageConsistent(t *testing.T, app *App) {
	t.Helper()
	rows, err := app.db.Query("SELECT note_id, storage_name FROM attachments")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	expected := make(map[string]bool)
	for rows.Next() {
		var noteID int64
		var storageName string
		if err := rows.Scan(&noteID, &storageName); err != nil {
			t.Fatal(err)
		}
		relative := filepath.Join(fmt.Sprint(noteID), storageName)
		expected[relative] = true
		if _, err := os.Stat(filepath.Join(app.attachmentsDir, relative)); err != nil {
			t.Fatalf("attachment row %s has no file: %v", relative, err)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	err = filepath.WalkDir(app.attachmentsDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(app.attachmentsDir, path)
		if err != nil {
			return err
		}
		if !expected[relative] {
			t.Errorf("unreferenced attachment file: %s", relative)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSearchDefaultsToTitleMode(t *testing.T) {
	app := newTestApp(t)
	handler := app.Handler(filepath.Join("..", "web", "frontend"))
	if _, err := app.CreateNote(Note{Title: "Encontrável"}); err != nil {
		t.Fatal(err)
	}

	response := performJSONRequest(t, handler, http.MethodGet, "/api/search?q=encontravel", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("search without mode status = %d, body = %s", response.Code, response.Body.String())
	}
	page := decodeResponse[Page](t, response)
	if page.Total != 1 {
		t.Fatalf("search without mode total = %d, want 1", page.Total)
	}

	response = performJSONRequest(t, handler, http.MethodGet, "/api/search?q=encontravel&mode=invalid", nil)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid mode status = %d, want 400", response.Code)
	}
}

func TestSecurityHeadersAreApplied(t *testing.T) {
	app := newTestApp(t)
	handler := app.Handler(filepath.Join("..", "web", "frontend"))

	for _, target := range []string{"/api/health", "/"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d", target, response.Code)
		}
		if got := response.Header().Get("Content-Security-Policy"); !strings.Contains(got, "script-src 'self'") {
			t.Fatalf("%s CSP = %q", target, got)
		}
		if response.Header().Get("X-Frame-Options") != "DENY" {
			t.Fatalf("%s missing X-Frame-Options", target)
		}
		if response.Header().Get("Referrer-Policy") != "no-referrer" {
			t.Fatalf("%s missing Referrer-Policy", target)
		}
	}
}
