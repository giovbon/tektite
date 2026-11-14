package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	ntfyMaxEventSize     = 8 << 20
	ntfyMaxMessageBytes  = 4 << 20
	ntfyTitleWordCount   = 3
	ntfyStateKey         = "ntfy_capture_state"
	ntfyStateVersion     = 1
	ntfySeenEventLimit   = 1000
	ntfySeenEventMaxAge  = 7 * 24 * time.Hour
	ntfyStartGrace       = 30 * time.Second
	ntfyDefaultFolder    = "Inbox"
	ntfyDefaultTag       = "ntfy"
	ntfyDefaultServerURL = "https://ntfy.sh"
)

// NtfyConfig holds the environment-driven capture settings. The feature is
// disabled unless NTFY_ENABLED is true, so existing installations keep working
// without any ntfy server.
type NtfyConfig struct {
	Enabled   bool
	ServerURL string
	Topic     string
	Username  string
	Password  string
	Folder    string
	Tags      []string
}

type ntfyEvent struct {
	ID         string         `json:"id"`
	Time       int64          `json:"time"`
	Event      string         `json:"event"`
	Topic      string         `json:"topic"`
	Title      string         `json:"title"`
	Message    string         `json:"message"`
	Attachment ntfyAttachment `json:"attachment"`
}

type ntfyAttachment struct {
	Name string `json:"name"`
	Type string `json:"type"`
	URL  string `json:"url"`
	Size int64  `json:"size"`
}

type ntfyCaptureState struct {
	Version int              `json:"version"`
	Since   int64            `json:"since"`
	Seen    map[string]int64 `json:"seen"`
}

// NtfyMonitor subscribes to one ntfy topic and turns each message into a note
// inside the configured virtual folder.
type NtfyMonitor struct {
	app       *App
	config    NtfyConfig
	serverURL *url.URL
	streamURL string
	client    *http.Client

	stateMu     sync.Mutex
	state       ntfyCaptureState
	stateLoaded bool
}

// LoadNtfyConfig reads the NTFY_* environment variables. Invalid values are
// reported here so the process fails fast instead of silently dropping
// notifications.
func LoadNtfyConfig() (NtfyConfig, error) {
	config := NtfyConfig{
		ServerURL: strings.TrimSpace(os.Getenv("NTFY_SERVER_URL")),
		Topic:     strings.TrimSpace(os.Getenv("NTFY_TOPIC")),
		Username:  strings.TrimSpace(os.Getenv("NTFY_USERNAME")),
		Password:  os.Getenv("NTFY_PASSWORD"),
		Folder:    strings.TrimSpace(os.Getenv("NTFY_FOLDER")),
	}
	if config.ServerURL == "" {
		config.ServerURL = ntfyDefaultServerURL
	}
	if config.Folder == "" {
		config.Folder = ntfyDefaultFolder
	}
	if raw := strings.TrimSpace(os.Getenv("NTFY_ENABLED")); raw != "" {
		enabled, err := strconv.ParseBool(raw)
		if err != nil {
			return NtfyConfig{}, fmt.Errorf("parse NTFY_ENABLED: %w", err)
		}
		config.Enabled = enabled
	}
	tags, err := parseNtfyTags(os.Getenv("NTFY_TAGS"))
	if err != nil {
		return NtfyConfig{}, err
	}
	config.Tags = tags
	return config, nil
}

func parseNtfyTags(raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return []string{ntfyDefaultTag}, nil
	}
	tags := make([]string, 0, 4)
	seen := make(map[string]struct{})
	for _, value := range strings.Split(raw, ",") {
		tag := strings.TrimSpace(value)
		if tag == "" {
			continue
		}
		if strings.ContainsAny(tag, "\r\n") || strings.Contains(tag, ",") {
			return nil, fmt.Errorf("invalid ntfy tag %q", value)
		}
		key := foldNtfyWord(tag)
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		tags = append(tags, tag)
	}
	if len(tags) == 0 {
		return []string{ntfyDefaultTag}, nil
	}
	return tags, nil
}

// NewNtfyMonitor validates a configuration and prepares the HTTP client. The
// client only follows redirects within the configured ntfy server so message
// attachments cannot redirect the backend to arbitrary hosts.
func NewNtfyMonitor(app *App, config NtfyConfig) (*NtfyMonitor, error) {
	if app == nil {
		return nil, errors.New("ntfy monitor requires an application")
	}
	if !config.Enabled {
		return nil, errors.New("ntfy capture is disabled")
	}
	serverURL, err := parseNtfyServerURL(config.ServerURL)
	if err != nil {
		return nil, err
	}
	if config.Topic == "" || strings.ContainsAny(config.Topic, "/?#") ||
		config.Topic == "." || config.Topic == ".." {
		return nil, errors.New("invalid ntfy topic")
	}
	if (config.Username == "") != (config.Password == "") {
		return nil, errors.New("ntfy username and password must both be configured")
	}
	folder, err := normalizeFolder(config.Folder)
	if err != nil {
		return nil, fmt.Errorf("invalid ntfy folder: %w", err)
	}
	if folder == "" {
		folder = ntfyDefaultFolder
	}
	config.Folder = folder
	tags := config.Tags
	if len(tags) == 0 {
		tags = []string{ntfyDefaultTag}
	}
	for _, tag := range tags {
		if strings.TrimSpace(tag) == "" || strings.ContainsAny(tag, ",\r\n") {
			return nil, errors.New("ntfy tags cannot be empty or contain commas or line breaks")
		}
	}
	config.Tags = tags

	streamURL := *serverURL
	streamURL.Path = strings.TrimRight(serverURL.Path, "/") + "/" + config.Topic + "/json"
	streamURL.RawPath = ""
	streamURL.RawQuery = ""
	streamURL.Fragment = ""

	client := &http.Client{
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("too many redirects")
			}
			if !sameNtfyOrigin(serverURL, request.URL) {
				return errors.New("ntfy redirect changed origin")
			}
			return nil
		},
	}

	return &NtfyMonitor{
		app:       app,
		config:    config,
		serverURL: serverURL,
		streamURL: streamURL.String(),
		client:    client,
		state: ntfyCaptureState{
			Version: ntfyStateVersion,
			Seen:    make(map[string]int64),
		},
	}, nil
}

func parseNtfyServerURL(raw string) (*url.URL, error) {
	serverURL, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || (serverURL.Scheme != "http" && serverURL.Scheme != "https") ||
		serverURL.Host == "" || serverURL.User != nil ||
		serverURL.RawQuery != "" || serverURL.Fragment != "" {
		return nil, errors.New("invalid ntfy server URL")
	}
	return serverURL, nil
}

// Run keeps the subscription alive until the context is cancelled. Reconnects
// use exponential backoff capped at 30 seconds, mirroring the reference
// implementation.
func (m *NtfyMonitor) Run(ctx context.Context) error {
	backoff := time.Second
	for {
		err := m.listen(ctx)
		if ctx.Err() != nil {
			return nil
		}
		log.Printf("ntfy monitor for topic %q disconnected: %v; reconnecting in %s",
			m.config.Topic, err, backoff)
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		if backoff < 30*time.Second {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}

func (m *NtfyMonitor) listen(ctx context.Context) error {
	if err := m.loadState(); err != nil {
		return fmt.Errorf("loading ntfy capture state: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.streamURL, nil)
	if err != nil {
		return fmt.Errorf("building ntfy request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if m.config.Username != "" {
		req.SetBasicAuth(m.config.Username, m.config.Password)
	}
	query := req.URL.Query()
	query.Set("since", strconv.FormatInt(m.currentSince(), 10))
	req.URL.RawQuery = query.Encode()

	resp, err := m.client.Do(req)
	if err != nil {
		return fmt.Errorf("connecting to ntfy: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("ntfy returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), ntfyMaxEventSize)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return nil
		}
		line := scanner.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var event ntfyEvent
		if err := json.Unmarshal(line, &event); err != nil {
			log.Printf("ntfy monitor received an invalid event: %v", err)
			continue
		}
		if event.Event != "message" || m.alreadyHandled(event) {
			continue
		}
		if err := m.captureEvent(ctx, event); err != nil {
			log.Printf("ntfy monitor could not capture message %q: %v", event.ID, err)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("reading ntfy stream: %w", err)
	}
	return io.EOF
}

func (m *NtfyMonitor) captureEvent(ctx context.Context, event ntfyEvent) error {
	if m.alreadyHandled(event) {
		return nil
	}

	stamp := time.Now().UTC()
	if event.Time > 0 {
		stamp = time.Unix(event.Time, 0).UTC()
	}
	attachmentNames := make([]string, 0, 1)
	if event.Attachment.Name != "" {
		attachmentNames = append(attachmentNames, event.Attachment.Name)
	}
	fallback := strings.TrimSpace(event.Title)
	if fallback == "" {
		fallback = "Captura ntfy " + stamp.Format("2006-01-02 15-04")
	}
	title := representativeTitle(event.Message, attachmentNames, fallback)
	content := m.noteContent(event, stamp, title)
	note := Note{
		Title:   title,
		Content: content,
		Folder:  m.config.Folder,
		Tags:    append([]string(nil), m.config.Tags...),
	}
	noteID, err := m.app.CreateNote(note)
	if err != nil {
		return fmt.Errorf("create note: %w", err)
	}

	if event.Attachment.URL != "" {
		link, err := m.saveAttachment(ctx, noteID, event.Attachment)
		if err != nil {
			log.Printf("ntfy monitor could not save attachment %q: %v", event.Attachment.Name, err)
		} else if link != "" {
			note.Content = content + "\n" + link + "\n"
			if err := m.app.UpdateNote(noteID, note); err != nil {
				log.Printf("ntfy monitor could not link attachment to note %d: %v", noteID, err)
			}
		}
	}
	return m.markCaptured(event)
}

func (m *NtfyMonitor) noteContent(event ntfyEvent, stamp time.Time, title string) string {
	var content strings.Builder
	content.WriteString("---\n")
	content.WriteString("tags: ")
	content.WriteString(strings.Join(m.config.Tags, ", "))
	content.WriteString("\n---\n\n")
	fmt.Fprintf(&content, "> Capturado em %s UTC do tópico `%s`.\n",
		stamp.Format("02/01/2006 às 15:04"), event.Topic)
	if eventTitle := strings.TrimSpace(event.Title); eventTitle != "" && eventTitle != title {
		fmt.Fprintf(&content, ">\n> **Título no ntfy:** %s\n", eventTitle)
	}
	if message := strings.TrimSpace(event.Message); message != "" {
		content.WriteString("\n")
		content.WriteString(truncateNtfyText(message, ntfyMaxMessageBytes))
		content.WriteString("\n")
	}
	return content.String()
}

func truncateNtfyText(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	truncated := value[:limit]
	// Avoid leaving half of a multi-byte rune at the cut point.
	truncated = strings.ToValidUTF8(truncated, "")
	return truncated + "\n\n… (mensagem truncada)"
}

func (m *NtfyMonitor) saveAttachment(ctx context.Context, noteID int64, attachment ntfyAttachment) (string, error) {
	attachmentURL, err := url.Parse(attachment.URL)
	if err != nil || !sameNtfyOrigin(m.serverURL, attachmentURL) || attachmentURL.User != nil {
		return "", errors.New("attachment URL is not on the configured ntfy server")
	}
	if attachment.Size > maxAttachmentSize {
		return "", fmt.Errorf("attachment exceeds %d MiB", maxAttachmentSize>>20)
	}
	name := "anexo"
	if cleaned, err := cleanAttachmentFilename(attachment.Name); err == nil {
		name = cleaned
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, attachmentURL.String(), nil)
	if err != nil {
		return "", fmt.Errorf("building attachment request: %w", err)
	}
	if m.config.Username != "" {
		req.SetBasicAuth(m.config.Username, m.config.Password)
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("requesting attachment: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("attachment returned HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > maxAttachmentSize {
		return "", fmt.Errorf("attachment exceeds %d MiB", maxAttachmentSize>>20)
	}

	item, err := m.app.SaveAttachment(noteID, resp.Body, name)
	if err != nil {
		return "", fmt.Errorf("saving attachment: %w", err)
	}
	label := strings.NewReplacer("[", `\[`, "]", `\]`).Replace(item.Filename)
	mediaType := strings.ToLower(item.MediaType)
	if strings.HasPrefix(mediaType, "application/octet-stream") {
		mediaType = strings.ToLower(attachment.Type)
	}
	if strings.HasPrefix(mediaType, "image/") {
		return fmt.Sprintf("![%s](%s)", label, item.URL), nil
	}
	return fmt.Sprintf("[%s](%s)", label, item.URL), nil
}

func sameNtfyOrigin(a, b *url.URL) bool {
	return a != nil && b != nil &&
		strings.EqualFold(a.Scheme, b.Scheme) &&
		strings.EqualFold(a.Host, b.Host)
}

func ntfyEventKey(event ntfyEvent) string {
	if event.ID != "" {
		return "id:" + event.ID
	}
	if event.Time > 0 {
		return "time:" + strconv.FormatInt(event.Time, 10)
	}
	return "msg:" + event.Message
}

func (m *NtfyMonitor) currentSince() int64 {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	return m.state.Since
}

func (m *NtfyMonitor) alreadyHandled(event ntfyEvent) bool {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	if event.Time > 0 && event.Time < m.state.Since {
		return true
	}
	_, seen := m.state.Seen[ntfyEventKey(event)]
	return seen
}

func (m *NtfyMonitor) loadState() error {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	if m.stateLoaded {
		return nil
	}

	var raw string
	err := m.app.db.QueryRow("SELECT value FROM app_settings WHERE key = ?", ntfyStateKey).Scan(&raw)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		m.state = ntfyCaptureState{
			Version: ntfyStateVersion,
			Since:   time.Now().Add(-ntfyStartGrace).Unix(),
			Seen:    make(map[string]int64),
		}
		m.stateLoaded = true
		return m.saveStateLocked()
	case err != nil:
		return err
	}
	if err := json.Unmarshal([]byte(raw), &m.state); err != nil {
		return fmt.Errorf("decoding state: %w", err)
	}
	if m.state.Version != ntfyStateVersion {
		return fmt.Errorf("unsupported state version %d", m.state.Version)
	}
	if m.state.Seen == nil {
		m.state.Seen = make(map[string]int64)
	}
	if m.state.Since <= 0 {
		// A fresh state starts slightly in the past so the first connection
		// does not import the whole ntfy history while still tolerating a
		// small clock difference with the server.
		m.state.Since = time.Now().Add(-ntfyStartGrace).Unix()
	}
	m.stateLoaded = true
	return nil
}

func (m *NtfyMonitor) markCaptured(event ntfyEvent) error {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	stamp := event.Time
	if stamp <= 0 {
		stamp = time.Now().Unix()
	}
	m.state.Seen[ntfyEventKey(event)] = stamp
	if stamp > m.state.Since {
		m.state.Since = stamp
	}
	m.pruneSeenLocked(stamp)
	return m.saveStateLocked()
}

func (m *NtfyMonitor) pruneSeenLocked(now int64) {
	if len(m.state.Seen) <= ntfySeenEventLimit {
		return
	}
	cutoff := now - int64(ntfySeenEventMaxAge/time.Second)
	for key, stamp := range m.state.Seen {
		if stamp < cutoff {
			delete(m.state.Seen, key)
		}
	}
	if len(m.state.Seen) <= ntfySeenEventLimit {
		return
	}
	type seenEntry struct {
		key   string
		stamp int64
	}
	entries := make([]seenEntry, 0, len(m.state.Seen))
	for key, stamp := range m.state.Seen {
		entries = append(entries, seenEntry{key: key, stamp: stamp})
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].stamp > entries[j].stamp
	})
	for _, entry := range entries[ntfySeenEventLimit:] {
		delete(m.state.Seen, entry.key)
	}
}

func (m *NtfyMonitor) saveStateLocked() error {
	data, err := json.Marshal(m.state)
	if err != nil {
		return fmt.Errorf("encoding state: %w", err)
	}
	_, err = m.app.db.Exec(`INSERT INTO app_settings(key, value, updated_at)
		VALUES (?, ?, datetime('now'))
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
		ntfyStateKey, string(data))
	if err != nil {
		return fmt.Errorf("saving state: %w", err)
	}
	return nil
}

// representativeTitle builds a short, human-readable note title from the
// message and the attachment filenames. It selects up to three words with the
// best combination of frequency, length and presence in a filename, then puts
// them back into the order they first appeared. The goal is to make the Inbox
// list readable without opening every note.
func representativeTitle(message string, attachmentNames []string, fallback string) string {
	words := representativeWords(message, attachmentNames, ntfyTitleWordCount)
	if len(words) == 0 {
		fallback = strings.TrimSpace(fallback)
		if fallback == "" {
			fallback = "Captura ntfy"
		}
		return truncateNtfyTitle(fallback)
	}
	title := strings.Join(words, " ")
	runes := []rune(title)
	if len(runes) > 0 {
		runes[0] = unicode.ToUpper(runes[0])
	}
	return truncateNtfyTitle(string(runes))
}

func truncateNtfyTitle(value string) string {
	runes := []rune(strings.Join(strings.Fields(value), " "))
	if len(runes) > 256 {
		runes = runes[:256]
	}
	return string(runes)
}

type ntfyKeyword struct {
	display string
	first   int
	count   int
	inFile  bool
}

var ntfyURLPattern = regexp.MustCompile(`(?i)(?:https?://|www\.)\S+`)

func representativeWords(message string, attachmentNames []string, limit int) []string {
	if limit < 1 {
		return nil
	}
	scores := make(map[string]*ntfyKeyword)
	position := 0

	add := func(text string, weight int, inFile bool) {
		text = ntfyURLPattern.ReplaceAllString(text, " ")
		for _, raw := range strings.FieldsFunc(text, func(r rune) bool {
			return !unicode.IsLetter(r) && !unicode.IsDigit(r)
		}) {
			runes := []rune(raw)
			if len(runes) < 2 || len(runes) > 48 {
				continue
			}
			key := foldNtfyWord(raw)
			if key == "" || isNtfyStopword(key) {
				continue
			}
			if isNtfyNumber(key) && !isPlausibleYear(key) {
				continue
			}
			entry := scores[key]
			if entry == nil {
				entry = &ntfyKeyword{
					display: displayNtfyWord(raw),
					first:   position,
				}
				scores[key] = entry
			}
			entry.count += weight
			if inFile {
				entry.inFile = true
			}
			position++
		}
	}

	add(message, 3, false)
	for _, name := range attachmentNames {
		add(attachmentBaseName(name), 2, true)
	}
	if len(scores) == 0 {
		return nil
	}

	candidates := make([]*ntfyKeyword, 0, len(scores))
	for _, entry := range scores {
		candidates = append(candidates, entry)
	}
	sort.Slice(candidates, func(i, j int) bool {
		left, right := ntfyKeywordScore(candidates[i]), ntfyKeywordScore(candidates[j])
		if left != right {
			return left > right
		}
		if candidates[i].first != candidates[j].first {
			return candidates[i].first < candidates[j].first
		}
		return candidates[i].display < candidates[j].display
	})
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].first < candidates[j].first
	})
	words := make([]string, 0, len(candidates))
	for _, entry := range candidates {
		words = append(words, entry.display)
	}
	return words
}

func ntfyKeywordScore(entry *ntfyKeyword) int {
	if entry == nil {
		return 0
	}
	score := entry.count*10 + min(len([]rune(entry.display)), 12)
	if entry.inFile {
		// Attachment names are usually chosen by the sender as a summary of
		// the content, so they deserve more weight than ordinary words.
		score += 12
	}
	return score
}

func attachmentBaseName(name string) string {
	name = path.Base(strings.ReplaceAll(name, `\`, "/"))
	if extension := path.Ext(name); extension != "" {
		name = strings.TrimSuffix(name, extension)
	}
	return name
}

func displayNtfyWord(raw string) string {
	runes := []rune(raw)
	if len(runes) == 0 {
		return ""
	}
	upper := 0
	for _, r := range runes {
		if unicode.IsUpper(r) {
			upper++
		}
	}
	if upper == 0 {
		return strings.ToLower(raw)
	}
	// Keep acronyms and proper nouns, but turn a fully shouted word into a
	// normal lowercase word so titles do not look like alerts.
	if upper == len(runes) && len(runes) > 4 {
		return strings.ToLower(raw)
	}
	return raw
}

func foldNtfyWord(value string) string {
	var builder strings.Builder
	for _, r := range strings.ToLower(value) {
		switch r {
		case 'á', 'à', 'â', 'ã', 'ä', 'å':
			builder.WriteRune('a')
		case 'é', 'è', 'ê', 'ë':
			builder.WriteRune('e')
		case 'í', 'ì', 'î', 'ï':
			builder.WriteRune('i')
		case 'ó', 'ò', 'ô', 'õ', 'ö':
			builder.WriteRune('o')
		case 'ú', 'ù', 'û', 'ü':
			builder.WriteRune('u')
		case 'ç':
			builder.WriteRune('c')
		case 'ñ':
			builder.WriteRune('n')
		default:
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func isNtfyNumber(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if !unicode.IsDigit(r) {
			return false
		}
	}
	return true
}

func isPlausibleYear(value string) bool {
	return len(value) == 4 && (strings.HasPrefix(value, "19") ||
		strings.HasPrefix(value, "20") || strings.HasPrefix(value, "21"))
}

func isNtfyStopword(value string) bool {
	_, found := ntfyStopwords[value]
	return found
}

// ntfyStopwords covers Portuguese function words plus generic words that show
// up in almost every notification ("arquivo", "anexo", "foto"...). English
// function words are included because links and shared content often mix both
// languages. Accents are folded before lookup, so "não" and "nao" match.
var ntfyStopwords = func() map[string]struct{} {
	words := []string{
		"a", "à", "às", "ao", "aos", "aquela", "aquelas", "aquele", "aqueles", "aquilo",
		"as", "até", "com", "como", "da", "das", "de", "dela", "delas", "dele", "deles",
		"depois", "do", "dos", "e", "é", "ela", "elas", "ele", "eles", "em", "entre",
		"era", "eram", "essa", "essas", "esse", "esses", "esta", "estas", "este", "estes",
		"fomos", "for", "foram", "fosse", "fui", "há", "havia", "isso", "isto", "já",
		"lhe", "lhes", "mais", "mas", "me", "mesmo", "meu", "meus", "minha", "minhas",
		"muito", "muita", "muitos", "muitas", "na", "não", "nao", "nas", "nem", "no",
		"nos", "nós", "nossa", "nossas", "nosso", "nossos", "num", "numa", "o", "os",
		"ou", "para", "pela", "pelas", "pelo", "pelos", "por", "qual", "quando", "que",
		"quem", "se", "seja", "sem", "ser", "seu", "seus", "só", "so", "sua", "suas",
		"também", "tambem", "te", "tem", "têm", "tenho", "ter", "teu", "teus", "tu",
		"tua", "tuas", "um", "uma", "você", "voce", "vocês", "voces", "vos",
		"ainda", "algo", "ali", "aqui", "assim", "bem", "cada", "coisa", "coisas",
		"depois", "então", "entao", "hoje", "lá", "la", "nada", "nunca", "onde",
		"ontem", "outra", "outras", "outro", "outros", "pouco", "porque", "sempre",
		"talvez", "toda", "todas", "todo", "todos", "tudo", "agora", "amanhã", "amanha",
		"sobre", "após", "apos", "antes", "durante", "contra", "desde", "sob",
		"preciso", "precisa", "precisam", "precisamos", "quero", "quer", "queria",
		"queremos", "vou", "vai", "vamos", "devo", "deve", "devemos", "fazer", "faz",
		"fazem", "feito", "feita", "enviar", "enviei", "envie", "mandei", "mandar",
		"manda", "recebi", "receber", "recebe", "gostaria", "poderia", "pode",
		"podem", "consegui", "consigo", "lembrete", "lembrar", "comprar", "comprei",
		"favor", "obrigado", "obrigada", "olá", "ola", "oi", "segue", "seguem",
		"veja", "vejam", "confira", "arquivo", "arquivos", "anexo", "anexos",
		"foto", "fotos", "imagem", "imagens", "documento", "documentos", "captura",
		"mensagem", "mensagens", "nota", "notas", "texto", "textos", "link", "links",
		"conteúdo", "conteudo", "informação", "informacao", "informações", "informacoes",
		"img", "dsc", "dscf", "pxl", "screenshot", "whatsapp", "telegram",
		"image", "images", "photo", "photos", "picture", "pictures", "file", "files",
		"attachment", "attachments", "final", "copia", "copy", "revisao", "rev",
		"versao", "version", "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9",
		"the", "be", "to", "of", "and", "in", "that", "have", "it", "for", "not",
		"on", "with", "he", "as", "you", "do", "at", "this", "but", "his", "by",
		"from", "they", "we", "her", "she", "or", "an", "will", "my", "all", "would",
		"there", "their", "what", "up", "out", "if", "about", "who", "which", "when",
		"make", "him", "know", "take", "people", "into", "your", "some", "could",
		"them", "other", "than", "then", "look", "its", "over", "think", "also",
		"after", "how", "our", "want", "because", "any", "these", "give",
		"pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "mp4", "mov", "txt",
		"doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "rar", "csv", "md",
		"m4a", "mp3", "wav", "ogg", "avi", "mkv",
	}
	result := make(map[string]struct{}, len(words))
	for _, word := range words {
		result[foldNtfyWord(word)] = struct{}{}
	}
	return result
}()
