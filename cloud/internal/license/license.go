package license

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// Tier 版本分层：free / cloud / advanced / pro
type Tier string

const (
	TierFree     Tier = "free"
	TierCloud    Tier = "cloud"
	TierAdvanced Tier = "advanced"
	TierPro      Tier = "pro"
)

const licenseSecretEnv = "SHELLPRO_LICENSE_SECRET"

func secret() []byte {
	if s := os.Getenv(licenseSecretEnv); s != "" {
		return []byte(s)
	}
	return []byte("shellpro-license-dev-secret")
}

// LicensePayload 自研授权载荷（自研密钥对签名，原创机制，不涉及第三方授权逻辑）
type LicensePayload struct {
	DeviceID string `json:"device_id"`
	Tier     Tier   `json:"tier"`
	Exp      int64  `json:"exp"` // unix 秒
	IssuedAt int64  `json:"iat"`
}

// Verify 校验授权签名与有效期，返回 tier
func Verify(deviceID, license string) (Tier, error) {
	parts := strings.SplitN(license, ".", 2)
	if len(parts) != 2 {
		return TierFree, ErrInvalidLicense
	}
	payloadB64, sigB64 := parts[0], parts[1]
	payloadRaw, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return TierFree, ErrInvalidLicense
	}
	sigRaw, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		return TierFree, ErrInvalidLicense
	}
	// HMAC-SHA256 自研签名校验
	mac := hmac.New(sha256.New, secret())
	mac.Write(payloadRaw)
	expected := mac.Sum(nil)
	if !hmac.Equal(sigRaw, expected) {
		return TierFree, ErrInvalidLicense
	}
	var p LicensePayload
	if err := json.Unmarshal(payloadRaw, &p); err != nil {
		return TierFree, ErrInvalidLicense
	}
	if time.Now().Unix() > p.Exp {
		return TierFree, ErrExpired
	}
	// 设备绑定校验
	if p.DeviceID != "" && p.DeviceID != deviceID {
		return TierFree, ErrDeviceMismatch
	}
	return p.Tier, nil
}

// Mint 开发用：签发测试授权（生产签发走独立离线签名工具）
func Mint(deviceID string, tier Tier, ttl time.Duration) (string, error) {
	p := LicensePayload{
		DeviceID: deviceID,
		Tier:     tier,
		IssuedAt: time.Now().Unix(),
		Exp:      time.Now().Add(ttl).Unix(),
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, secret())
	mac.Write(raw)
	sig := mac.Sum(nil)
	return base64.RawURLEncoding.EncodeToString(raw) + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// VerifyHandler POST /api/v1/auth/license/verify
func VerifyHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			DeviceID string `json:"deviceId"`
			License  string `json:"license"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.License == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		tier, err := Verify(req.DeviceID, req.License)
		if err != nil {
			c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "tier": tier})
			return
		}
		c.JSON(http.StatusOK, gin.H{"tier": tier})
	}
}
