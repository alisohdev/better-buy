package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"golang.org/x/crypto/argon2"
	"math/big"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var ErrInvalidCredentials = errors.New("اطلاعات ورود یا کد تأیید معتبر نیست.")
var ErrLimited = errors.New("درخواست‌ها محدود شده‌اند؛ کمی بعد دوباره تلاش کنید.")
var ErrDelivery = errors.New("ارسال پیامک ممکن نشد؛ دوباره تلاش کنید.")

func NormalizeDigits(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= '۰' && r <= '۹' {
			return r - '۰' + '0'
		}
		if r >= '٠' && r <= '٩' {
			return r - '٠' + '0'
		}
		return r
	}, s)
}
func NormalizePhone(p string) (string, error) {
	p = NormalizeDigits(strings.TrimSpace(p))
	if strings.HasPrefix(p, "0") {
		p = "+98" + p[1:]
	} else if strings.HasPrefix(p, "98") {
		p = "+" + p
	}
	if len(p) != 13 || !strings.HasPrefix(p, "+989") {
		return "", ErrInvalidCredentials
	}
	for _, c := range p[1:] {
		if c < '0' || c > '9' {
			return "", ErrInvalidCredentials
		}
	}
	return p, nil
}
func validPassword(p string) bool {
	return utf8.ValidString(p) && utf8.RuneCountInString(p) >= 12 && len(p) <= 1024
}
func argonSettings() (uint32, uint32, uint8) {
	read := func(name string, fallback, min, max int) int {
		n, e := strconv.Atoi(os.Getenv(name))
		if e != nil || n < min || n > max {
			return fallback
		}
		return n
	}
	return uint32(read("ARGON2_TIME", 3, 2, 6)), uint32(read("ARGON2_MEMORY_KIB", 65536, 19456, 262144)), uint8(read("ARGON2_THREADS", 2, 1, 4))
}
func hashPassword(p string) (string, error) {
	salt := make([]byte, 16)
	if _, e := rand.Read(salt); e != nil {
		return "", e
	}
	t, m, threads := argonSettings()
	key := argon2.IDKey([]byte(p), salt, t, m, threads, 32)
	return fmt.Sprintf("argon2id:%d:%d:%d:%s:%s", t, m, threads, hex.EncodeToString(salt), hex.EncodeToString(key)), nil
}
func verifyPassword(encoded, p string) bool {
	parts := strings.Split(encoded, ":")
	salt := make([]byte, 16)
	expected := make([]byte, 32)
	t, m, threads := argonSettings()
	valid := false
	if len(parts) == 6 && parts[0] == "argon2id" {
		a, e := hex.DecodeString(parts[4])
		b, f := hex.DecodeString(parts[5])
		tv, te := strconv.Atoi(parts[1])
		mv, me := strconv.Atoi(parts[2])
		pv, pe := strconv.Atoi(parts[3])
		if e == nil && f == nil && te == nil && me == nil && pe == nil && len(a) == 16 && len(b) == 32 && tv >= 2 && tv <= 6 && mv >= 19456 && mv <= 262144 && pv >= 1 && pv <= 4 {
			salt = a
			expected = b
			t = uint32(tv)
			m = uint32(mv)
			threads = uint8(pv)
			valid = true
		}
	}
	key := argon2.IDKey([]byte(p), salt, t, m, threads, 32)
	return hmac.Equal(key, expected) && valid
}
func (s *Service) digest(v string) string {
	m := hmac.New(sha256.New, s.otpSecret)
	m.Write([]byte(v))
	return hex.EncodeToString(m.Sum(nil))
}
func (s *Service) Limit(ctx context.Context, key string, seconds, limit int64) error {
	window := time.Now().Unix() / seconds * seconds
	var count int
	e := s.db.QueryRowContext(ctx, `INSERT INTO auth_limits(key,window,count) VALUES(?,?,1) ON CONFLICT(key,window) DO UPDATE SET count=count+1 WHERE count<? RETURNING count`, s.digest(key), window, limit).Scan(&count)
	if errors.Is(e, sql.ErrNoRows) {
		return ErrLimited
	}
	return e
}
func (s *Service) Start(ctx context.Context, phone, purpose string) (string, error) {
	phone, e := NormalizePhone(phone)
	if e != nil || (purpose != "registration" && purpose != "password_reset") {
		return "", ErrInvalidCredentials
	}
	now := time.Now().Unix()
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return "", e
	}
	defer tx.Rollback()
	var latest int64
	var count int
	e = tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(created),0),COUNT(*) FROM otp_challenges WHERE phone=? AND created>?`, phone, now-86400).Scan(&latest, &count)
	if e != nil {
		return "", e
	}
	if latest > now-60 || count >= 10 {
		return "", ErrLimited
	}
	_, e = tx.ExecContext(ctx, `DELETE FROM auth_tickets WHERE phone=? AND purpose=?`, phone, purpose)
	if e != nil {
		return "", e
	}
	id := randomToken(32)
	if id == "" {
		return "", errors.New("random challenge generation failed")
	}
	n, e := rand.Int(rand.Reader, big.NewInt(1000000))
	if e != nil {
		return "", e
	}
	code := fmt.Sprintf("%06d", n.Int64())
	_, e = tx.ExecContext(ctx, `UPDATE otp_challenges SET consumed=1 WHERE phone=? AND purpose=?`, phone, purpose)
	if e != nil {
		return "", e
	}
	_, e = tx.ExecContext(ctx, `INSERT INTO otp_challenges(id,phone,purpose,verifier,expires,created) VALUES(?,?,?,?,?,?)`, id, phone, purpose, s.digest(id+":"+code), now+180, now)
	if e != nil {
		return "", e
	}
	if e = tx.Commit(); e != nil {
		return "", e
	}
	var exists int
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM "user" WHERE phone=?`, phone).Scan(&exists)
	send := purpose == "registration" && exists == 0 || purpose == "password_reset" && exists > 0
	if send {
		if s.SMS == nil || s.SMS.SendOTP(ctx, phone, code) != nil {
			_, _ = s.db.ExecContext(ctx, `UPDATE otp_challenges SET consumed=1 WHERE id=?`, id)
			return id, nil
		}
		_, e = s.db.ExecContext(ctx, `UPDATE otp_challenges SET delivered=1 WHERE id=?`, id)
	}
	return id, e
}
func (s *Service) Verify(ctx context.Context, id, code string) (string, error) {
	code = NormalizeDigits(code)
	if len(code) != 6 {
		return "", ErrInvalidCredentials
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return "", e
	}
	defer tx.Rollback()
	var phone, purpose, verifier string
	var attempts int
	// Acquire SQLite write lock before reading, serializing verification and attempt counting.
	e = tx.QueryRowContext(ctx, `UPDATE otp_challenges SET attempts=attempts+1 WHERE id=? AND consumed=0 AND delivered=1 AND attempts<5 AND expires>? RETURNING phone,purpose,verifier,attempts`, id, time.Now().Unix()).Scan(&phone, &purpose, &verifier, &attempts)
	if e != nil {
		return "", ErrInvalidCredentials
	}
	if !hmac.Equal([]byte(verifier), []byte(s.digest(id+":"+code))) {
		if e = tx.Commit(); e != nil {
			return "", e
		}
		return "", ErrInvalidCredentials
	}
	ticket := randomToken(32)
	if ticket == "" {
		return "", errors.New("random ticket generation failed")
	}
	_, e = tx.ExecContext(ctx, `UPDATE otp_challenges SET consumed=1 WHERE id=?`, id)
	if e == nil {
		_, e = tx.ExecContext(ctx, `INSERT INTO auth_tickets VALUES(?,?,?,?)`, s.digest(ticket), phone, purpose, time.Now().Unix()+300)
	}
	if e == nil {
		e = tx.Commit()
	}
	return ticket, e
}
func (s *Service) Complete(ctx context.Context, ticket, name, password string, reset bool) (Identity, error) {
	if !validPassword(password) || (!reset && (strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > 120)) {
		return Identity{}, ErrInvalidCredentials
	}
	hash, e := hashPassword(password)
	if e != nil {
		return Identity{}, e
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return Identity{}, e
	}
	defer tx.Rollback()
	purpose := "registration"
	if reset {
		purpose = "password_reset"
	}
	var phone string
	e = tx.QueryRowContext(ctx, `DELETE FROM auth_tickets WHERE hash=? AND purpose=? AND expires>? RETURNING phone`, s.digest(ticket), purpose, time.Now().Unix()).Scan(&phone)
	if e != nil {
		return Identity{}, ErrInvalidCredentials
	}
	now := time.Now().UTC()
	stamp := now.Format(time.RFC3339Nano)
	id := randomID()
	var identity Identity
	if reset {
		e = tx.QueryRowContext(ctx, `UPDATE "user" SET password_hash=?,updatedAt=? WHERE phone=? RETURNING id`, hash, stamp, phone).Scan(&id)
		if e == nil {
			_, e = tx.ExecContext(ctx, `DELETE FROM session WHERE userId=?`, id)
		}
	} else {
		_, e = tx.ExecContext(ctx, `INSERT INTO "user"(id,name,legacy_identity,phone,phoneVerified,phone_verified_at,password_hash,createdAt,updatedAt) VALUES(?,?,?,?,1,?,?,?,?)`, id, strings.TrimSpace(name), "inactive:"+id, phone, stamp, hash, stamp, stamp)
		if e == nil {
			identity, e = createSession(ctx, tx, id, strings.TrimSpace(name), phone, true, nil, now)
		}
	}
	if e != nil {
		return Identity{}, ErrInvalidCredentials
	}
	_, e = tx.ExecContext(ctx, `DELETE FROM auth_tickets WHERE phone=?`, phone)
	if e == nil {
		e = tx.Commit()
	}
	return identity, e
}
func (s *Service) SignIn(ctx context.Context, phone, password string) (Identity, error) {
	phone, e := NormalizePhone(phone)
	if e != nil || len(password) > 1024 {
		return Identity{}, ErrInvalidCredentials
	}
	var id, name, hash string
	e = s.db.QueryRowContext(ctx, `SELECT id,name,password_hash FROM "user" WHERE phone=? AND phoneVerified=1`, phone).Scan(&id, &name, &hash)
	ok := verifyPassword(hash, password)
	if e != nil || !ok {
		return Identity{}, ErrInvalidCredentials
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return Identity{}, e
	}
	defer tx.Rollback()
	identity, e := createSession(ctx, tx, id, name, phone, true, nil, time.Now().UTC())
	if e == nil {
		e = tx.Commit()
	}
	return identity, e
}
func (s *Service) Cleanup(ctx context.Context) error {
	now := time.Now().Unix()
	for _, q := range []string{`DELETE FROM otp_challenges WHERE created<?`, `DELETE FROM auth_tickets WHERE expires<?`, `DELETE FROM auth_limits WHERE window<?`} {
		cutoff := now
		if strings.Contains(q, "created") {
			cutoff = now - 86400
		}
		if strings.Contains(q, "window") {
			cutoff = now - 86400
		}
		if _, e := s.db.ExecContext(ctx, q, cutoff); e != nil {
			return e
		}
	}
	_, e := s.db.ExecContext(ctx, `DELETE FROM session WHERE expiresAt<?`, time.Now().UTC().Format(time.RFC3339Nano))
	return e
}
