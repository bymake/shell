package auth

import (
	"sync"
	"time"
)

// User 用户账号（生产环境落 MySQL；此处为内存实现，便于脚手架直接运行）
type User struct {
	ID        int64     `json:"id"`
	Email     string    `json:"email"`
	Password  string    `json:"-"` // bcrypt hash
	CreatedAt time.Time `json:"created_at"`
}

// Store 用户存储接口（后续可替换为 MySQL 实现）
type Store interface {
	CreateUser(email, passwordHash string) (*User, error)
	FindByEmail(email string) (*User, error)
	Count() int64
}

// MemStore 内存实现，线程安全
type MemStore struct {
	mu    sync.RWMutex
	seq   int64
	users map[string]*User // key: email
}

func NewMemStore() *MemStore {
	return &MemStore{users: make(map[string]*User)}
}

func (m *MemStore) CreateUser(email, passwordHash string) (*User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.users[email]; ok {
		return nil, ErrEmailExists
	}
	m.seq++
	u := &User{ID: m.seq, Email: email, Password: passwordHash, CreatedAt: time.Now()}
	m.users[email] = u
	return u, nil
}

func (m *MemStore) FindByEmail(email string) (*User, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	u, ok := m.users[email]
	if !ok {
		return nil, ErrUserNotFound
	}
	return u, nil
}

func (m *MemStore) Count() int64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return int64(len(m.users))
}
