package api

import (
	"database/sql"
	"github.com/alirezasoheili/better-buy/apps/api/internal/auth"
	"github.com/alirezasoheili/better-buy/apps/api/internal/config"
	"net/http"
	"strconv"
	"time"
)

func registerAdminScans(mux *http.ServeMux, db *sql.DB, cfg config.Config, authService *auth.Service, admin func(http.HandlerFunc) http.Handler) {
	mux.Handle("GET /api/admin/scans", admin(func(w http.ResponseWriter, r *http.Request) {
		user := r.URL.Query().Get("userId")
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if page < 1 {
			page = 1
		}
		if page > 100000 {
			writeJSON(w, 400, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		if len(user) > 200 {
			writeJSON(w, 400, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		rows, err := db.QueryContext(r.Context(), `SELECT id,user_id,source,status,error_code,created_at,finished_at,product_count,deal_count FROM scans WHERE (?='' OR user_id=?) ORDER BY created_at DESC,id DESC LIMIT 100 OFFSET ?`, user, user, (page-1)*100)
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": "ADMIN_SCAN_READ_ERROR"})
			return
		}
		defer rows.Close()
		items := []map[string]any{}
		for rows.Next() {
			var id, owner, source, status, created string
			var code, finished sql.NullString
			var products, deals int
			if err = rows.Scan(&id, &owner, &source, &status, &code, &created, &finished, &products, &deals); err != nil {
				writeJSON(w, 503, map[string]string{"error": "ADMIN_SCAN_READ_ERROR"})
				return
			}
			items = append(items, map[string]any{"id": id, "userId": owner, "source": source, "status": status, "errorCode": code.String, "createdAt": created, "finishedAt": finished.String, "productCount": products, "dealCount": deals})
		}
		if rows.Err() != nil {
			writeJSON(w, 503, map[string]string{"error": "ADMIN_SCAN_READ_ERROR"})
			return
		}
		writeJSON(w, 200, map[string]any{"data": items})
	}))
	mux.Handle("GET /api/admin/scans/{id}/products", admin(func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if len(id) > 200 {
			writeJSON(w, 400, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if page < 1 {
			page = 1
		}
		if page > 100000 {
			writeJSON(w, 400, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		rows, err := db.QueryContext(r.Context(), `SELECT title,vendor_title,final_price_rials,discount_ratio FROM deals WHERE scan_id=? ORDER BY id LIMIT 50 OFFSET ?`, id, (page-1)*50)
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": "ADMIN_SCAN_READ_ERROR"})
			return
		}
		defer rows.Close()
		items := []map[string]any{}
		for rows.Next() {
			var title, vendor string
			var price, discount float64
			if rows.Scan(&title, &vendor, &price, &discount) != nil {
				writeJSON(w, 503, map[string]string{"error": "ADMIN_SCAN_READ_ERROR"})
				return
			}
			items = append(items, map[string]any{"title": title, "vendorTitle": vendor, "price": price, "discount": discount})
		}
		if rows.Err() != nil {
			writeJSON(w, 503, map[string]string{"error": "ADMIN_SCAN_READ_ERROR"})
			return
		}
		writeJSON(w, 200, map[string]any{"data": items})
	}))
	mux.Handle("GET /api/admin/scan-logs", admin(func(w http.ResponseWriter, r *http.Request) {
		user, scan := r.URL.Query().Get("userId"), r.URL.Query().Get("scanId")
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if page < 1 {
			page = 1
		}
		if page > 100000 {
			writeJSON(w, 400, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		if len(user) > 200 || len(scan) > 200 {
			writeJSON(w, 400, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		rows, err := db.QueryContext(r.Context(), `SELECT scan_id,user_id,source,status,COALESCE(error_code,''),updated_at,product_count,deal_count FROM scan_diagnostics WHERE updated_at>? AND (?='' OR user_id=?) AND (?='' OR scan_id=?) ORDER BY updated_at DESC LIMIT 100 OFFSET ?`, time.Now().UTC().Add(-72*time.Hour).Format(time.RFC3339Nano), user, user, scan, scan, (page-1)*100)
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": "ADMIN_LOG_READ_ERROR"})
			return
		}
		defer rows.Close()
		items := []map[string]any{}
		for rows.Next() {
			var id, owner, source, status, code, stamp string
			var products, deals int
			if rows.Scan(&id, &owner, &source, &status, &code, &stamp, &products, &deals) != nil {
				writeJSON(w, 503, map[string]string{"error": "ADMIN_LOG_READ_ERROR"})
				return
			}
			items = append(items, map[string]any{"id": id, "userId": owner, "source": source, "status": status, "errorCode": code, "createdAt": stamp, "productCount": products, "dealCount": deals})
		}
		if rows.Err() != nil {
			writeJSON(w, 503, map[string]string{"error": "ADMIN_LOG_READ_ERROR"})
			return
		}
		writeJSON(w, 200, map[string]any{"data": items})
	}))
	mux.Handle("DELETE /api/admin/scans", admin(func(w http.ResponseWriter, r *http.Request) {
		origin := false
		for _, v := range cfg.CORSOrigins {
			if v != "" && r.Header.Get("Origin") == v {
				origin = true
			}
		}
		if !origin {
			writeJSON(w, 403, map[string]string{"error": "INVALID_ORIGIN"})
			return
		}
		var body struct {
			UserID       string `json:"userId"`
			ScanID       string `json:"scanId"`
			Confirmation string `json:"confirmation"`
			Password     string `json:"password"`
		}
		if decodeFlexibleJSON(r, &body) != nil || body.Confirmation != "DELETE SCANS" || len(body.UserID) > 200 || len(body.ScanID) > 200 {
			writeJSON(w, 400, map[string]string{"error": "INVALID_CONFIRMATION"})
			return
		}
		if !authService.VerifyAccountPassword(r.Context(), requestIdentity(r).User.ID, body.Password) {
			writeJSON(w, 403, map[string]string{"error": "ADMIN_PASSWORD_REQUIRED"})
			return
		}
		tx, err := db.BeginTx(r.Context(), nil)
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": "DELETE_REQUEST_FAILED"})
			return
		}
		defer tx.Rollback()
		now := time.Now().UTC().Format(time.RFC3339Nano)
		result, err := tx.ExecContext(r.Context(), `INSERT OR IGNORE INTO scan_delete_requests(scan_id,requested_at) SELECT id,? FROM scans WHERE (?='' OR user_id=?) AND (?='' OR id=?)`, now, body.UserID, body.UserID, body.ScanID, body.ScanID)
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": "DELETE_REQUEST_FAILED"})
			return
		}
		count, _ := result.RowsAffected()
		target := "all scans"
		if body.UserID != "" {
			target = "user:" + body.UserID
		}
		if body.ScanID != "" {
			target = "scan:" + body.ScanID
		}
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO admin_scan_audit(admin_id,action,target,created_at) VALUES(?,'delete_scans',?,?)`, requestIdentity(r).User.ID, target, now); err != nil {
			writeJSON(w, 503, map[string]string{"error": "DELETE_REQUEST_FAILED"})
			return
		}
		if tx.Commit() != nil {
			writeJSON(w, 503, map[string]string{"error": "DELETE_REQUEST_FAILED"})
			return
		}
		writeJSON(w, 202, map[string]any{"data": map[string]any{"queued": count}})
	}))
}
