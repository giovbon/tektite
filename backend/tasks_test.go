package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestExtractTasksFindsMarkersOutsideFrontmatter(t *testing.T) {
	content := "---\ntags: TODO\nTODO: metadado\n---\n\n# Nota\n\nTODO: revisar o texto\nlinha com FIXME - corrigir depois\nTODOLIST não é tarefa\nveja TODO e BUG: juntos\n```go\n// HACK: contorno temporário\n```\n"
	tasks := extractTasks(content, DefaultTaskMarkers)

	want := []taskMatch{
		{Marker: "TODO", Text: "revisar o texto", Line: 8},
		{Marker: "FIXME", Text: "corrigir depois", Line: 9},
		{Marker: "TODO", Text: "e BUG: juntos", Line: 11},
		{Marker: "BUG", Text: "juntos", Line: 11},
		{Marker: "HACK", Text: "contorno temporário", Line: 13},
	}
	if len(tasks) != len(want) {
		t.Fatalf("task count = %d, want %d: %#v", len(tasks), len(want), tasks)
	}
	for index, expected := range want {
		if tasks[index] != expected {
			t.Fatalf("task %d = %#v, want %#v", index, tasks[index], expected)
		}
	}
}

func TestParseTaskMarkersNormalizesAndRejectsInvalidValues(t *testing.T) {
	markers, err := ParseTaskMarkers("todo, FIXME: ; bug bug TODO")
	if err != nil {
		t.Fatal(err)
	}
	expected := []string{"TODO", "FIXME", "BUG"}
	if len(markers) != len(expected) {
		t.Fatalf("markers = %#v", markers)
	}
	for index := range expected {
		if markers[index] != expected[index] {
			t.Fatalf("markers = %#v, want %#v", markers, expected)
		}
	}
	defaults, err := ParseTaskMarkers("")
	if err != nil || len(defaults) != len(DefaultTaskMarkers) {
		t.Fatalf("default markers = %#v, err = %v", defaults, err)
	}
	if _, err := ParseTaskMarkers("TODO:!,FIXME"); err == nil {
		t.Fatal("invalid marker should be rejected")
	}
}

func TestTasksEndpointFiltersByMarker(t *testing.T) {
	app, err := NewApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	notes := []Note{
		{Title: "Projeto", Folder: "Trabalho", Content: "# Plano\nTODO: escrever proposta\nBUG: corrigir cálculo\n"},
		{Title: "Pessoal", Content: "FIXME: comprar café\n"},
	}
	for _, note := range notes {
		if _, err := app.CreateNote(note); err != nil {
			t.Fatal(err)
		}
	}

	handler := app.Handler(filepath.Join("..", "web", "frontend"))
	request := httptest.NewRequest(http.MethodGet, "/api/tasks?markers=TODO,BUG", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("tasks status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload TaskList
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Total != 2 || len(payload.Items) != 2 {
		t.Fatalf("unexpected task list: %#v", payload)
	}
	if payload.Items[0].NoteTitle != "Projeto" || payload.Items[0].Folder != "Trabalho" ||
		payload.Items[0].Marker != "TODO" || payload.Items[0].Line != 2 {
		t.Fatalf("unexpected first task: %#v", payload.Items[0])
	}
	if payload.Items[1].Marker != "BUG" || payload.Items[1].Line != 3 {
		t.Fatalf("unexpected second task: %#v", payload.Items[1])
	}

	invalid := httptest.NewRequest(http.MethodGet, "/api/tasks?markers=TODO%20!", nil)
	invalidResponse := httptest.NewRecorder()
	handler.ServeHTTP(invalidResponse, invalid)
	if invalidResponse.Code != http.StatusBadRequest {
		t.Fatalf("invalid marker status = %d", invalidResponse.Code)
	}
}

func TestTaskMarkerSettingsPersistAndFeedTasks(t *testing.T) {
	dataDir := t.TempDir()
	app, err := NewApp(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	handler := app.Handler(filepath.Join("..", "web", "frontend"))

	defaults := httptest.NewRequest(http.MethodGet, "/api/task-markers", nil)
	defaultsResponse := httptest.NewRecorder()
	handler.ServeHTTP(defaultsResponse, defaults)
	if defaultsResponse.Code != http.StatusOK {
		t.Fatalf("default markers status = %d", defaultsResponse.Code)
	}
	var defaultPayload TaskMarkerSettings
	if err := json.Unmarshal(defaultsResponse.Body.Bytes(), &defaultPayload); err != nil {
		t.Fatal(err)
	}
	if len(defaultPayload.Markers) != len(DefaultTaskMarkers) {
		t.Fatalf("unexpected default markers: %#v", defaultPayload)
	}

	body := strings.NewReader(`{"markers":["todo","LATER"]}`)
	save := httptest.NewRequest(http.MethodPut, "/api/task-markers", body)
	saveResponse := httptest.NewRecorder()
	handler.ServeHTTP(saveResponse, save)
	if saveResponse.Code != http.StatusOK {
		t.Fatalf("save markers status = %d, body = %s", saveResponse.Code, saveResponse.Body.String())
	}
	var saved TaskMarkerSettings
	if err := json.Unmarshal(saveResponse.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if len(saved.Markers) != 2 || saved.Markers[0] != "TODO" || saved.Markers[1] != "LATER" {
		t.Fatalf("unexpected saved markers: %#v", saved)
	}

	if _, err := app.CreateNote(Note{Title: "Configurada", Content: "LATER: revisar esta ideia\n"}); err != nil {
		t.Fatal(err)
	}
	tasks := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	tasksResponse := httptest.NewRecorder()
	handler.ServeHTTP(tasksResponse, tasks)
	if tasksResponse.Code != http.StatusOK {
		t.Fatalf("tasks status = %d", tasksResponse.Code)
	}
	var taskPayload TaskList
	if err := json.Unmarshal(tasksResponse.Body.Bytes(), &taskPayload); err != nil {
		t.Fatal(err)
	}
	if taskPayload.Total != 1 || taskPayload.Items[0].Marker != "LATER" {
		t.Fatalf("tasks did not use saved markers: %#v", taskPayload)
	}

	invalid := httptest.NewRequest(http.MethodPut, "/api/task-markers",
		strings.NewReader(`{"markers":["TODO!"]}`))
	invalidResponse := httptest.NewRecorder()
	handler.ServeHTTP(invalidResponse, invalid)
	if invalidResponse.Code != http.StatusBadRequest {
		t.Fatalf("invalid markers status = %d", invalidResponse.Code)
	}

	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewApp(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	markers, err := reopened.TaskMarkers()
	if err != nil {
		t.Fatal(err)
	}
	if len(markers) != 2 || markers[1] != "LATER" {
		t.Fatalf("markers did not survive reopening: %#v", markers)
	}
}
