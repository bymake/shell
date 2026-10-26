package main

import (
	"log"
	"os"

	"github.com/gin-gonic/gin"

	"github.com/shell/cloud/internal/auth"
	"github.com/shell/cloud/internal/license"
	"github.com/shell/cloud/internal/sync"
)

func main() {
	userStore := auth.NewMemStore()
	syncStore := sync.NewMemStore()

	r := gin.Default()

	api := r.Group("/api/v1")

	// ---- 认证（T5-5）----
	api.POST("/auth/register", auth.RegisterHandler(userStore))
	api.POST("/auth/login", auth.LoginHandler(userStore))
	// 授权校验（T5-6）
	api.POST("/auth/license/verify", license.VerifyHandler())

	// ---- 云端同步（T5-7），需 JWT ----
	syncGroup := api.Group("", auth.JWTMiddleware())
	syncGroup.GET("/sync/changes", sync.ChangesHandler(syncStore))
	syncGroup.POST("/sync/push", sync.PushHandler(syncStore))
	syncGroup.GET("/sync/meta", sync.MetaHandler(syncStore))

	addr := os.Getenv("SHELLPRO_API_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	log.Printf("ShellPro cloud API listening on %s", addr)
	if err := r.Run(addr); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
