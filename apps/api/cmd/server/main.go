package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/alirezasoheili/better-buy/apps/api/internal/api"
	"github.com/alirezasoheili/better-buy/apps/api/internal/config"
	"github.com/alirezasoheili/better-buy/apps/api/internal/products"
	"github.com/alirezasoheili/better-buy/apps/api/internal/providers"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
	"github.com/alirezasoheili/better-buy/apps/api/internal/storage"
	"github.com/alirezasoheili/better-buy/apps/api/internal/wishlist"
)

func main() {
	if err := run(); err != nil {
		slog.Error("HTTP service stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	startupCtx, cancelStartup := context.WithTimeout(context.Background(), 10*time.Second)
	db, err := storage.Open(startupCtx, cfg.DatabasePath)
	cancelStartup()
	if err != nil {
		return err
	}
	defer db.Close()

	collector := providers.New(db)
	queue, err := scans.NewQueue(db, collector, scans.Options{SnappStoreCampaignsEnabled: cfg.SnappStoreCampaignsEnabled})
	if err != nil {
		return err
	}
	wishlistStore := wishlist.New(db, cfg.BoxKey)
	maintainer := wishlist.NewMaintainer(wishlistStore, queue, products.New(db, cfg.BoxKey), cfg.WishlistScheduleEnabled, cfg.APIRateLimitsEnabled, wishlist.PushConfig{
		PublicKey:  cfg.VAPIDPublicKey,
		PrivateKey: cfg.VAPIDPrivateKey,
		Subject:    cfg.VAPIDSubject,
	})

	server := &http.Server{
		Addr:              net.JoinHostPort(cfg.HTTPHost, strconv.Itoa(int(cfg.HTTPPort))),
		Handler:           api.New(db, cfg, queue),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	queueResult := make(chan error, 1)
	go func() {
		queueResult <- queue.Run(ctx)
	}()
	serveResult := make(chan error, 1)
	go func() {
		serveResult <- server.ListenAndServe()
	}()
	maintenanceResult := make(chan error, 1)
	go func() {
		maintenanceResult <- maintainer.Run(ctx)
	}()

	select {
	case err := <-serveResult:
		stop()
		<-queueResult
		<-maintenanceResult
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case err := <-queueResult:
		if err == nil && ctx.Err() == nil {
			err = errors.New("scan queue stopped unexpectedly")
		}
		stop()
		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelShutdown()
		_ = server.Shutdown(shutdownCtx)
		<-serveResult
		<-maintenanceResult
		if ctx.Err() != nil && err == nil {
			return nil
		}
		return err
	case err := <-maintenanceResult:
		if err == nil && ctx.Err() == nil {
			err = errors.New("wishlist maintenance stopped unexpectedly")
		}
		stop()
		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelShutdown()
		_ = server.Shutdown(shutdownCtx)
		<-serveResult
		<-queueResult
		if ctx.Err() != nil && err == nil {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelShutdown()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return err
		}
		if err := <-serveResult; err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		<-queueResult
		<-maintenanceResult
		return nil
	}
	return nil
}
