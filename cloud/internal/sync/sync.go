package sync

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// Change 同步变更单元（对应开发文档第 7 节 change 结构）
type Change struct {
	Table     string                 `json:"table"`
	ID        int64                  `json:"id"`
	Op        string                 `json:"op"` // upsert|delete
	Data      map[string]interface{} `json:"data,omitempty"`
	UpdatedAt string                 `json:"updated_at"`
}

// SyncMeta 同步元信息
type SyncMeta struct {
	DeviceID string `json:"deviceId"`
	LastTs   string `json:"lastTs"`
}

// Store 同步存储接口（生产落 MySQL/Redis；此处内存实现）
type Store interface {
	Append(userID int64, changes []Change) (accepted int, conflicts []Change)
	Since(userID int64, ts string) ([]Change, string)
	Meta(userID int64) SyncMeta
}

type memStore struct {
	mu      sync.RWMutex
	seq     int64
	byUser  map[int64][]Change // 追加顺序即服务端时间序
	meta    map[int64]SyncMeta
	devices map[int64]string
}

func NewMemStore() Store {
	return &memStore{
		byUser:  make(map[int64][]Change),
		meta:    make(map[int64]SyncMeta),
		devices: make(map[int64]string),
	}
}

func tsNow() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func (m *memStore) Append(userID int64, changes []Change) (int, []Change) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cur := m.byUser[userID]
	accepted := 0
	for _, ch := range changes {
		// 已存在同表同 id 的更高/相同版本则视为冲突（简化冲突检测）
		dup := false
		for _, existing := range cur {
			if existing.Table == ch.Table && existing.ID == ch.ID && existing.UpdatedAt == ch.UpdatedAt {
				dup = true
				break
			}
		}
		if dup {
			continue // 已应用，ack 但不重复
		}
		cur = append(cur, ch)
		accepted++
	}
	m.byUser[userID] = cur
	return accepted, nil
}

func (m *memStore) Since(userID int64, ts string) ([]Change, string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	cur := m.byUser[userID]
	var out []Change
	for _, ch := range cur {
		if ts == "" || ch.UpdatedAt > ts {
			out = append(out, ch)
		}
	}
	serverTime := tsNow()
	if len(cur) > 0 {
		serverTime = cur[len(cur)-1].UpdatedAt
	}
	return out, serverTime
}

func (m *memStore) Meta(userID int64) SyncMeta {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if d, ok := m.meta[userID]; ok {
		return d
	}
	return SyncMeta{DeviceID: "", LastTs: ""}
}

// ChangesHandler GET /api/v1/sync/changes?since=&device=
func ChangesHandler(s Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := c.GetInt64("userID")
		since := c.Query("since")
		changes, serverTime := s.Since(userID, since)
		c.JSON(http.StatusOK, gin.H{"changes": changes, "serverTime": serverTime})
	}
}

// PushHandler POST /api/v1/sync/push
func PushHandler(s Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := c.GetInt64("userID")
		var req struct {
			Changes []Change `json:"changes"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}
		accepted, conflicts := s.Append(userID, req.Changes)
		c.JSON(http.StatusOK, gin.H{"accepted": accepted, "conflicts": conflicts})
	}
}

// MetaHandler GET /api/v1/sync/meta
func MetaHandler(s Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := c.GetInt64("userID")
		c.JSON(http.StatusOK, s.Meta(userID))
	}
}
