package auth

import (
	"errors"
)

var (
	ErrEmailExists   = errors.New("邮箱已被注册")
	ErrUserNotFound  = errors.New("用户不存在")
	ErrBadCredential = errors.New("邮箱或密码错误")
)
