package license

import "errors"

var (
	ErrInvalidLicense = errors.New("授权码无效")
	ErrExpired        = errors.New("授权已过期")
	ErrDeviceMismatch = errors.New("授权与设备不匹配")
)
