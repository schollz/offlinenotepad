package app

import "sync"

type hub struct {
	mu         sync.Mutex
	workspaces map[string]map[*socketClient]struct{}
}

func newHub() *hub { return &hub{workspaces: make(map[string]map[*socketClient]struct{})} }

func (h *hub) add(c *socketClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.workspaces[c.workspaceID]
	if set == nil {
		set = make(map[*socketClient]struct{})
		h.workspaces[c.workspaceID] = set
	}
	set[c] = struct{}{}
}

func (h *hub) remove(c *socketClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.workspaces[c.workspaceID]
	delete(set, c)
	if len(set) == 0 {
		delete(h.workspaces, c.workspaceID)
	}
}

func (h *hub) broadcast(sender *socketClient, message socketMessage) {
	h.mu.Lock()
	clients := make([]*socketClient, 0, len(h.workspaces[sender.workspaceID]))
	for c := range h.workspaces[sender.workspaceID] {
		if c != sender {
			clients = append(clients, c)
		}
	}
	h.mu.Unlock()
	for _, c := range clients {
		_ = c.write(message)
	}
}

func (h *hub) rotate(sender *socketClient) {
	h.mu.Lock()
	clients := make([]*socketClient, 0, len(h.workspaces[sender.workspaceID]))
	for c := range h.workspaces[sender.workspaceID] {
		if c != sender {
			clients = append(clients, c)
		}
	}
	h.mu.Unlock()
	for _, c := range clients {
		_ = c.write(socketMessage{Type: messageCredentialsRotated})
		c.close()
	}
}
