package auth

import (
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

const (
	authSecretEnv = "SHELLPRO_JWT_SECRET"
	tokenTTL       = 24 * time.Hour
)

func secret() []byte {
	if s := os.Getenv(authSecretEnv); s != "" {
		return []byte(s)
	}
	// 仅限本地开发默认值；生产必须通过环境变量注入
	return []byte("shellpro-dev-secret-change-me")
}

func hashPassword(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	return string(b), err
}

func verifyPassword(hash, pw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

func issueToken(userID int64, email string) (string, error) {
	claims := jwt.MapClaims{
		"sub":   userID,
		"email": email,
		"iat":   time.Now().Unix(),
		"exp":   time.Now().Add(tokenTTL).Unix(),
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return t.SignedString(secret())
}

// RegisterHandler POST /api/v1/auth/register
func RegisterHandler(store Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Email    string `json:"email" binding:"required,email"`
			Password string `json:"password" binding:"required,min=6"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}
		hash, err := hashPassword(req.Password)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "服务错误"})
			return
		}
		u, err := store.CreateUser(req.Email, hash)
		if err != nil {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		tok, err := issueToken(u.ID, u.Email)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "签发令牌失败"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"token": tok, "user": u})
	}
}

// LoginHandler POST /api/v1/auth/login
func LoginHandler(store Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Email    string `json:"email" binding:"required"`
			Password string `json:"password" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		u, err := store.FindByEmail(req.Email)
		if err != nil || !verifyPassword(u.Password, req.Password) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": ErrBadCredential.Error()})
			return
		}
		tok, err := issueToken(u.ID, u.Email)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "签发令牌失败"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"token": tok, "user": u})
	}
}
