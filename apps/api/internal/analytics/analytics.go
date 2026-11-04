package analytics

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const UsersPerPage = 30

var (
	ErrInvalidEvent          = errors.New("invalid analytics event")
	ErrUnauthenticatedSearch = errors.New("search analytics requires a session")
	uuidPattern              = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
)

type Event struct {
	ID        string `json:"id"`
	VisitorID string `json:"visitorId"`
	Kind      string `json:"kind"`
	Query     string `json:"query,omitempty"`
	Source    string `json:"source,omitempty"`
}

func (event Event) ValidIdentifiers() bool {
	return uuidPattern.MatchString(event.ID) && uuidPattern.MatchString(event.VisitorID)
}

type Totals struct {
	Users         int `json:"users"`
	Visits        int `json:"visits"`
	Visitors      int `json:"visitors"`
	Searches      int `json:"searches"`
	Scans         int `json:"scans"`
	Locations     int `json:"locations"`
	WishlistItems int `json:"wishlistItems"`
	CartItems     int `json:"cartItems"`
}

type Day struct {
	Date     string `json:"date"`
	Visits   int    `json:"visits"`
	Visitors int    `json:"visitors"`
	Searches int    `json:"searches"`
}

type Search struct {
	Query    string `json:"query"`
	Searches int    `json:"searches"`
	Users    int    `json:"users"`
}

type Overview struct {
	GeneratedAt   string   `json:"generatedAt"`
	TrackingSince *string  `json:"trackingSince"`
	Totals        Totals   `json:"totals"`
	Days          []Day    `json:"days"`
	TopSearches   []Search `json:"topSearches"`
}

type User struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Email         string  `json:"email"`
	EmailVerified bool    `json:"emailVerified"`
	CreatedAt     string  `json:"createdAt"`
	LastSeenAt    *string `json:"lastSeenAt"`
	Visits        int     `json:"visits"`
	Searches      int     `json:"searches"`
	Scans         int     `json:"scans"`
	Locations     int     `json:"locations"`
	WishlistItems int     `json:"wishlistItems"`
	CartItems     int     `json:"cartItems"`
}

type UserPage struct {
	Users    []User `json:"users"`
	Page     int    `json:"page"`
	PageSize int    `json:"pageSize"`
	Total    int    `json:"total"`
}

type Location struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	IsDefault bool    `json:"isDefault"`
}

type WishlistItem struct {
	ID          string `json:"id"`
	Phrase      string `json:"phrase"`
	MinDiscount int    `json:"minDiscount"`
	CreatedAt   string `json:"createdAt"`
}

type CartItem struct {
	Source    string `json:"source"`
	Key       string `json:"key"`
	Title     string `json:"title"`
	Quantity  int    `json:"quantity"`
	UpdatedAt string `json:"updatedAt"`
}

type RecentSearch struct {
	Query     string `json:"query"`
	Source    string `json:"source"`
	CreatedAt string `json:"createdAt"`
}

type UserDetail struct {
	User           User           `json:"user"`
	Locations      []Location     `json:"locations"`
	Wishlist       []WishlistItem `json:"wishlist"`
	Cart           []CartItem     `json:"cart"`
	RecentSearches []RecentSearch `json:"recentSearches"`
}

type Service struct{ db *sql.DB }

func New(db *sql.DB) *Service { return &Service{db: db} }

func (s *Service) Record(ctx context.Context, userID string, event Event) error {
	if !event.ValidIdentifiers() {
		return ErrInvalidEvent
	}
	var query, source any
	switch event.Kind {
	case "visit":
		if event.Query != "" || event.Source != "" {
			return ErrInvalidEvent
		}
	case "search":
		if userID == "" {
			return ErrUnauthenticatedSearch
		}
		text := strings.Join(strings.Fields(norm.NFKC.String(event.Query)), " ")
		if utf8.RuneCountInString(text) < 2 || utf8.RuneCountInString(text) > 120 {
			return ErrInvalidEvent
		}
		switch event.Source {
		case "snappmarket", "okala", "digikalajet", "all":
		default:
			return ErrInvalidEvent
		}
		query, source = text, event.Source
	default:
		return ErrInvalidEvent
	}
	var owner any
	if userID != "" {
		owner = userID
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO analytics_events(id,visitor_id,user_id,kind,query,source,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, strings.ToLower(event.ID), strings.ToLower(event.VisitorID), owner, event.Kind, query, source, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (s *Service) Overview(ctx context.Context) (Overview, error) {
	now := time.Now().UTC()
	result := Overview{GeneratedAt: now.Format(time.RFC3339Nano), Days: make([]Day, 30), TopSearches: make([]Search, 0)}
	var since sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM "user"),
		COALESCE(SUM(kind='visit'),0), COUNT(DISTINCT CASE WHEN kind='visit' THEN visitor_id END),
		COALESCE(SUM(kind='search'),0),
		(SELECT COUNT(*) FROM scans), (SELECT COUNT(*) FROM locations WHERE user_id IN (SELECT id FROM "user")),
		(SELECT COUNT(*) FROM wishlist_items WHERE user_id IN (SELECT id FROM "user")),
		(SELECT COALESCE(SUM(quantity),0) FROM provider_carts WHERE user_id IN (SELECT id FROM "user")),
		MIN(created_at) FROM analytics_events`).Scan(&result.Totals.Users, &result.Totals.Visits, &result.Totals.Visitors, &result.Totals.Searches, &result.Totals.Scans, &result.Totals.Locations, &result.Totals.WishlistItems, &result.Totals.CartItems, &since)
	if err != nil {
		return Overview{}, err
	}
	if since.Valid {
		result.TrackingSince = &since.String
	}
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, -29)
	for i := range result.Days {
		result.Days[i].Date = start.AddDate(0, 0, i).Format(time.DateOnly)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT SUBSTR(created_at,1,10), COALESCE(SUM(kind='visit'),0), COUNT(DISTINCT CASE WHEN kind='visit' THEN visitor_id END), COALESCE(SUM(kind='search'),0) FROM analytics_events WHERE created_at>=? GROUP BY SUBSTR(created_at,1,10) ORDER BY 1`, start.Format(time.RFC3339))
	if err != nil {
		return Overview{}, err
	}
	byDate := make(map[string]Day)
	for rows.Next() {
		var day Day
		if err := rows.Scan(&day.Date, &day.Visits, &day.Visitors, &day.Searches); err != nil {
			rows.Close()
			return Overview{}, err
		}
		byDate[day.Date] = day
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return Overview{}, err
	}
	rows.Close()
	for i, day := range result.Days {
		if counted, ok := byDate[day.Date]; ok {
			result.Days[i] = counted
		}
	}
	rows, err = s.db.QueryContext(ctx, `SELECT query,COUNT(*),COUNT(DISTINCT user_id) FROM analytics_events WHERE kind='search' GROUP BY query ORDER BY COUNT(*) DESC,query LIMIT 20`)
	if err != nil {
		return Overview{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var search Search
		if err := rows.Scan(&search.Query, &search.Searches, &search.Users); err != nil {
			return Overview{}, err
		}
		result.TopSearches = append(result.TopSearches, search)
	}
	return result, rows.Err()
}

const userColumns = `u.id,u.name,u.email,u.emailVerified,u.createdAt,
	(SELECT MAX(created_at) FROM analytics_events e WHERE e.user_id=u.id),
	(SELECT COUNT(*) FROM analytics_events e WHERE e.user_id=u.id AND e.kind='visit'),
	(SELECT COUNT(*) FROM analytics_events e WHERE e.user_id=u.id AND e.kind='search'),
	(SELECT COUNT(*) FROM scans s WHERE s.user_id=u.id),
	(SELECT COUNT(*) FROM locations l WHERE l.user_id=u.id),
	(SELECT COUNT(*) FROM wishlist_items w WHERE w.user_id=u.id),
	(SELECT COALESCE(SUM(quantity),0) FROM provider_carts c WHERE c.user_id=u.id)`

type scanner interface{ Scan(...any) error }

func scanUser(row scanner) (User, error) {
	var result User
	var lastSeen sql.NullString
	err := row.Scan(&result.ID, &result.Name, &result.Email, &result.EmailVerified, &result.CreatedAt, &lastSeen, &result.Visits, &result.Searches, &result.Scans, &result.Locations, &result.WishlistItems, &result.CartItems)
	if lastSeen.Valid {
		result.LastSeenAt = &lastSeen.String
	}
	return result, err
}

func (s *Service) Users(ctx context.Context, query string, page int) (UserPage, error) {
	result := UserPage{Users: make([]User, 0), Page: page, PageSize: UsersPerPage}
	query = strings.TrimSpace(query)
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM "user" u WHERE ?='' OR INSTR(LOWER(u.email || ' ' || u.name),LOWER(?))>0`, query, query).Scan(&result.Total)
	if err != nil {
		return UserPage{}, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+userColumns+` FROM "user" u WHERE ?='' OR INSTR(LOWER(u.email || ' ' || u.name),LOWER(?))>0 ORDER BY u.createdAt DESC,u.id LIMIT ? OFFSET ?`, query, query, UsersPerPage, (page-1)*UsersPerPage)
	if err != nil {
		return UserPage{}, err
	}
	defer rows.Close()
	for rows.Next() {
		user, err := scanUser(rows)
		if err != nil {
			return UserPage{}, err
		}
		result.Users = append(result.Users, user)
	}
	return result, rows.Err()
}

func (s *Service) User(ctx context.Context, userID string) (UserDetail, error) {
	result := UserDetail{Locations: make([]Location, 0), Wishlist: make([]WishlistItem, 0), Cart: make([]CartItem, 0), RecentSearches: make([]RecentSearch, 0)}
	user, err := scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM "user" u WHERE u.id=?`, userID))
	if err != nil {
		return UserDetail{}, err
	}
	result.User = user
	rows, err := s.db.QueryContext(ctx, `SELECT id,name,latitude,longitude,is_default FROM locations WHERE user_id=? ORDER BY is_default DESC,created_at,id`, userID)
	if err != nil {
		return UserDetail{}, err
	}
	for rows.Next() {
		var item Location
		if err := rows.Scan(&item.ID, &item.Name, &item.Latitude, &item.Longitude, &item.IsDefault); err != nil {
			rows.Close()
			return UserDetail{}, err
		}
		result.Locations = append(result.Locations, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return UserDetail{}, err
	}
	rows.Close()
	rows, err = s.db.QueryContext(ctx, `SELECT id,phrase,min_discount,created_at FROM wishlist_items WHERE user_id=? ORDER BY created_at,id`, userID)
	if err != nil {
		return UserDetail{}, err
	}
	for rows.Next() {
		var item WishlistItem
		if err := rows.Scan(&item.ID, &item.Phrase, &item.MinDiscount, &item.CreatedAt); err != nil {
			rows.Close()
			return UserDetail{}, err
		}
		result.Wishlist = append(result.Wishlist, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return UserDetail{}, err
	}
	rows.Close()
	rows, err = s.db.QueryContext(ctx, `SELECT source,group_key,title,quantity,updated_at FROM provider_carts WHERE user_id=? ORDER BY source,created_at,group_key`, userID)
	if err != nil {
		return UserDetail{}, err
	}
	for rows.Next() {
		var item CartItem
		if err := rows.Scan(&item.Source, &item.Key, &item.Title, &item.Quantity, &item.UpdatedAt); err != nil {
			rows.Close()
			return UserDetail{}, err
		}
		result.Cart = append(result.Cart, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return UserDetail{}, err
	}
	rows.Close()
	rows, err = s.db.QueryContext(ctx, `SELECT query,source,created_at FROM analytics_events WHERE user_id=? AND kind='search' ORDER BY created_at DESC,id DESC LIMIT 30`, userID)
	if err != nil {
		return UserDetail{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var item RecentSearch
		if err := rows.Scan(&item.Query, &item.Source, &item.CreatedAt); err != nil {
			return UserDetail{}, err
		}
		result.RecentSearches = append(result.RecentSearches, item)
	}
	return result, rows.Err()
}
