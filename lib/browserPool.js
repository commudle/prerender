const util = require('./util.js');
const chrome = require('./browsers/chrome');
const EventEmitter = require('events');

class BrowserPool extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      maxConnections: options.maxConnections || 5,
      minConnections: options.minConnections || 1,
      maxIdleTime: options.maxIdleTime || 300000, // 5 minutes
      connectionTimeout: options.connectionTimeout || 30000,
      restartAfterUses: options.restartAfterUses || 100,
      healthCheckInterval: options.healthCheckInterval || 60000, // 1 minute
      scaleUpQueuedThreshold: options.scaleUpQueuedThreshold || 3, // if queued requests exceed this and we can create more
      scaleUpUtilizationThreshold: options.scaleUpUtilizationThreshold || 0.8, // busy/total
      scaleDownIdleTime: options.scaleDownIdleTime || 120000, // 2 minutes idle for scale down beyond min
      maxConnectionAge: options.maxConnectionAge || 30 * 60 * 1000, // 30 minutes
      maxConsecutiveFailures: options.maxConsecutiveFailures || 3,
      ...options,
    };

    this.connections = new Map();
    this.busyConnections = new Set();
    this.requestQueue = [];
    this.connectionCount = 0;
    this.totalConnections = 0;
    this.isShuttingDown = false;

    // metrics (non-sensitive operational counters)
    this.metrics = {
      acquireTimeouts: 0,
      totalAcquireRequests: 0,
      totalQueuedRequests: 0,
      peakQueueLength: 0,
      createdConnections: 0,
      destroyedConnections: 0,
      recycledConnections: 0,
      scaleUpEvents: 0,
      scaleUpFailures: 0,
      scaleDownRecycles: 0,
      healthCheckRuns: 0,
      consecutiveAcquireErrors: 0,
    };

    // Don't initialize pool automatically - let server control when to start
    // Health check will be started after pool initialization
  }

  async initializePool() {
    util.log(
      `Initializing browser pool with ${this.options.minConnections} connections`,
    );
    const promises = [];

    for (let i = 0; i < this.options.minConnections; i++) {
      promises.push(this.createConnection());
    }

    try {
      await Promise.all(promises);
      util.log('Browser pool initialized successfully');

      // Start health check only after successful initialization
      this.startHealthCheck();
    } catch (error) {
      util.log('Error initializing browser pool:', error);
      throw error;
    }
  }

  async createConnection() {
    if (this.connectionCount >= this.options.maxConnections) {
      throw new Error('Maximum connections reached');
    }

    const connectionId = `conn_${++this.totalConnections}`;
    util.log(`Creating new browser connection: ${connectionId}`);

    try {
      // Create a new Chrome instance
      const browser = Object.create(chrome);
      await browser.spawn(this.options);
      await browser.connect();

      const connection = {
        id: connectionId,
        browser,
        createdAt: Date.now(),
        lastUsed: Date.now(),
        useCount: 0,
        isHealthy: true,
        tabs: new Map(),
        consecutiveFailures: 0,
      };

      this.connections.set(connectionId, connection);
      this.connectionCount++;
      this.metrics.createdConnections++;

      util.log(`Browser connection ${connectionId} created successfully`);
      this.emit('connectionCreated', connection);

      return connection;
    } catch (error) {
      util.log(`Failed to create browser connection ${connectionId}:`, error);
      throw error;
    }
  }

  async getConnection() {
    return new Promise((resolve, reject) => {
      this.metrics.totalAcquireRequests++;
      // Try to get an available connection immediately
      const connection = this.getAvailableConnection();
      if (connection) {
        this.markConnectionBusy(connection);
        return resolve(connection);
      }

      const acquireTimeout = this.options.connectionTimeout || 30000;
      const queuedAt = Date.now();
      const timeoutHandle = setTimeout(() => {
        // Remove this request from queue if still present
        const index = this.requestQueue.findIndex((r) => r._id === reqId);
        if (index !== -1) {
          this.requestQueue.splice(index, 1);
        }
        const waitMs = Date.now() - queuedAt;
        util.log(
          `BrowserPool acquire timeout after ${waitMs}ms (queue length: ${this.requestQueue.length}, busy: ${this.busyConnections.size}/${this.connectionCount})`,
        );
        this.metrics.acquireTimeouts++;
        this.metrics.consecutiveAcquireErrors++;
        reject(new Error('BROWSER_POOL_ACQUIRE_TIMEOUT'));
      }, acquireTimeout);

      const reqId = `${queuedAt}_${Math.random().toString(36).slice(2)}`;
      // Queue the request if no connection is available
      this.requestQueue.push({
        _id: reqId,
        resolve: (conn) => {
          clearTimeout(timeoutHandle);
          this.metrics.consecutiveAcquireErrors = 0; // reset streak
          resolve(conn);
        },
        reject: (err) => {
          clearTimeout(timeoutHandle);
          reject(err);
        },
        timestamp: queuedAt,
      });
      this.metrics.totalQueuedRequests++;
      if (this.requestQueue.length > this.metrics.peakQueueLength) {
        this.metrics.peakQueueLength = this.requestQueue.length;
      }
      this.processQueue();
    });
  }

  getAvailableConnection() {
    for (const [id, connection] of this.connections) {
      if (!this.busyConnections.has(id) && connection.isHealthy) {
        return connection;
      }
    }
    return null;
  }

  markConnectionBusy(connection) {
    this.busyConnections.add(connection.id);
    connection.lastUsed = Date.now();
    connection.useCount++;
  }

  releaseConnection(connection) {
    if (this.busyConnections.has(connection.id)) {
      this.busyConnections.delete(connection.id);
      connection.lastUsed = Date.now();

      // Process any queued requests
      this.processQueue();

      // Check if connection should be recycled
      if (connection.useCount >= this.options.restartAfterUses) {
        util.log(
          `Connection ${connection.id} reached max uses (${connection.useCount}), recycling`,
        );
        this.recycleConnection(connection);
      }
    }
  }

  async processQueue() {
    if (this.requestQueue.length === 0) return;

    // Try to fulfill requests with existing connections
    while (this.requestQueue.length > 0) {
      const connection = this.getAvailableConnection();
      if (!connection) break;

      const request = this.requestQueue.shift();
      this.markConnectionBusy(connection);
      request.resolve(connection);
    }

    // Create new connections if needed and allowed
    if (
      this.requestQueue.length > 0 &&
      this.connectionCount < this.options.maxConnections
    ) {
      try {
        const newConnection = await this.createConnection();
        if (this.requestQueue.length > 0) {
          const request = this.requestQueue.shift();
          this.markConnectionBusy(newConnection);
          request.resolve(newConnection);
        }
      } catch (error) {
        // If we can't create a new connection, the queued requests will wait
        util.log('Failed to create new connection for queue:', error);
      }
    }

    // Decide whether to scale up based on thresholds
    const statsTotal = this.connectionCount || 1;
    const utilization = this.busyConnections.size / statsTotal;
    if (
      this.requestQueue.length >= this.options.scaleUpQueuedThreshold &&
      this.connectionCount < this.options.maxConnections
    ) {
      util.log(
        `Scaling decision: queueLength=${this.requestQueue.length} (>= ${this.options.scaleUpQueuedThreshold}) attempting to add connection`,
      );
      this._attemptScaleUp();
    } else if (
      utilization >= this.options.scaleUpUtilizationThreshold &&
      this.requestQueue.length > 0 &&
      this.connectionCount < this.options.maxConnections
    ) {
      util.log(
        `Scaling decision: utilization=${utilization.toFixed(2)} (>= ${this.options.scaleUpUtilizationThreshold}) with queueLength=${this.requestQueue.length} attempting to add connection`,
      );
      this._attemptScaleUp();
    }
  }

  async _attemptScaleUp() {
    try {
      await this.createConnection();
      // Immediately process queue again after adding
      this.processQueue();
      this.metrics.scaleUpEvents++;
    } catch (e) {
      util.log('Scale up attempt failed:', e.message || e);
      this.metrics.scaleUpFailures++;
    }
  }

  async recycleConnection(connection) {
    util.log(`Recycling connection ${connection.id}`);

    try {
      // Remove from active connections
      this.connections.delete(connection.id);
      this.busyConnections.delete(connection.id);
      this.connectionCount--;
      this.metrics.destroyedConnections++;
      this.metrics.recycledConnections++;

      // Close the old browser
      if (connection.browser && connection.browser.kill) {
        connection.browser.kill();
      }

      // Create a new connection to replace it (if not shutting down)
      if (
        !this.isShuttingDown &&
        this.connectionCount < this.options.minConnections
      ) {
        await this.createConnection();
      }
    } catch (error) {
      util.log(`Error recycling connection ${connection.id}:`, error);
    }
  }

  startHealthCheck() {
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.options.healthCheckInterval);
  }

  async performHealthCheck() {
    util.log('Performing browser pool health check');
    this.metrics.healthCheckRuns++;

    const now = Date.now();
    const connectionsToRecycle = [];

    for (const [id, connection] of this.connections) {
      // Check for idle connections
      const idleTime = now - connection.lastUsed;
      if (
        idleTime > this.options.maxIdleTime &&
        !this.busyConnections.has(id) &&
        this.connectionCount > this.options.minConnections
      ) {
        util.log(
          `Connection ${id} idle for ${idleTime}ms, marking for removal`,
        );
        connectionsToRecycle.push(connection);
        this.metrics.scaleDownRecycles++;
        continue;
      }

      // Scale down aggressively if above min and above scaleDownIdleTime
      if (
        idleTime > this.options.scaleDownIdleTime &&
        !this.busyConnections.has(id) &&
        this.connectionCount > this.options.minConnections
      ) {
        util.log(
          `Connection ${id} idle for ${idleTime}ms (> scaleDownIdleTime ${this.options.scaleDownIdleTime}), scaling down`,
        );
        connectionsToRecycle.push(connection);
        this.metrics.scaleDownRecycles++;
        continue;
      }

      // Recycle very old connections
      if (now - connection.createdAt > this.options.maxConnectionAge) {
        util.log(
          `Connection ${id} exceeded max age (${now - connection.createdAt}ms), recycling`,
        );
        connectionsToRecycle.push(connection);
        continue;
      }

      // Basic health check - you can enhance this
      if (!connection.browser || !connection.isHealthy) {
        util.log(`Connection ${id} failed health check`);
        connection.isHealthy = false;
        connectionsToRecycle.push(connection);
      }

      // Placeholder: if we tracked consecutiveFailures elsewhere
      if (
        connection.consecutiveFailures &&
        connection.consecutiveFailures >= this.options.maxConsecutiveFailures
      ) {
        util.log(
          `Connection ${id} exceeded max consecutive failures (${connection.consecutiveFailures}), recycling`,
        );
        connectionsToRecycle.push(connection);
        continue;
      }
    }

    // Recycle unhealthy connections
    for (const connection of connectionsToRecycle) {
      await this.recycleConnection(connection);
    }

    // Ensure minimum connections
    while (
      this.connectionCount < this.options.minConnections &&
      !this.isShuttingDown
    ) {
      try {
        await this.createConnection();
      } catch (error) {
        util.log('Failed to maintain minimum connections:', error);
        break;
      }
    }
  }

  async openTab(options) {
    const connection = await this.getConnection();

    try {
      const tab = await connection.browser.openTab(options);

      // Store tab reference for cleanup
      connection.tabs.set(tab.target, tab);

      return {
        ...tab,
        _connection: connection,
        _pool: this,
      };
    } catch (error) {
      // Release connection on error
      this.releaseConnection(connection);
      throw error;
    }
  }

  async closeTab(tab) {
    if (tab._connection && tab._pool) {
      const connection = tab._connection;

      try {
        // Remove tab reference
        if (connection.tabs.has(tab.target)) {
          connection.tabs.delete(tab.target);
        }

        // Close the tab
        await connection.browser.closeTab(tab);

        // Release the connection back to the pool
        this.releaseConnection(connection);
      } catch (error) {
        util.log('Error closing tab:', error);
        // Still release the connection
        this.releaseConnection(connection);
        throw error;
      }
    } else {
      throw new Error('Tab was not created through the pool');
    }
  }

  getStats() {
    return {
      totalConnections: this.connections.size,
      busyConnections: this.busyConnections.size,
      availableConnections: this.connections.size - this.busyConnections.size,
      queuedRequests: this.requestQueue.length,
      utilization: this.connections.size
        ? this.busyConnections.size / this.connections.size
        : 0,
      metrics: {
        ...this.metrics,
        queueLength: this.requestQueue.length,
        options: {
          max: this.options.maxConnections,
          min: this.options.minConnections,
        },
      },
      connections: Array.from(this.connections.values()).map((conn) => ({
        id: conn.id,
        createdAt: conn.createdAt,
        lastUsed: conn.lastUsed,
        useCount: conn.useCount,
        isHealthy: conn.isHealthy,
        isBusy: this.busyConnections.has(conn.id),
        activeTabs: conn.tabs.size,
      })),
    };
  }

  async shutdown() {
    util.log('Shutting down browser pool');
    this.isShuttingDown = true;

    // Stop health check
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    // Reject any queued requests
    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift();
      request.reject(new Error('Browser pool is shutting down'));
    }

    // Close all connections
    const closePromises = [];
    for (const [id, connection] of this.connections) {
      if (connection.browser && connection.browser.kill) {
        closePromises.push(
          new Promise((resolve) => {
            connection.browser.kill();
            setTimeout(resolve, 1000); // Give it time to close
          }),
        );
        this.metrics.destroyedConnections++;
      }
    }

    await Promise.all(closePromises);

    this.connections.clear();
    this.busyConnections.clear();
    this.connectionCount = 0;

    util.log('Browser pool shutdown complete');
  }
}

module.exports = BrowserPool;
