const { contextBridge, ipcRenderer } = require('electron');

// Everything the renderer (the React UI) is allowed to do — a deliberately
// narrow surface, no direct filesystem/db/network access from the
// renderer process at all.
contextBridge.exposeInMainWorld('pos', {
  listProducts: (params) => ipcRenderer.invoke('pos:listProducts', params),
  createProduct: (input) => ipcRenderer.invoke('pos:createProduct', input),
  listCustomers: (params) => ipcRenderer.invoke('pos:listCustomers', params),
  createCustomer: (input) => ipcRenderer.invoke('pos:createCustomer', input),
  addStockBatch: (input) => ipcRenderer.invoke('pos:addStockBatch', input),
  createSale: (input) => ipcRenderer.invoke('pos:createSale', input),
  deleteSale: (saleId) => ipcRenderer.invoke('pos:deleteSale', saleId),
  addPayment: (saleId, amount) => ipcRenderer.invoke('pos:addPayment', { saleId, amount }),
  listSales: (params) => ipcRenderer.invoke('pos:listSales', params),
  getSale: (saleId) => ipcRenderer.invoke('pos:getSale', saleId),
  pendingSyncCount: () => ipcRenderer.invoke('pos:pendingSyncCount'),
  syncStatus: () => ipcRenderer.invoke('pos:syncStatus'),
  login: (username, password) => ipcRenderer.invoke('pos:login', { username, password }),
  isLoggedIn: () => ipcRenderer.invoke('pos:isLoggedIn'),
  getProfile: () => ipcRenderer.invoke('pos:getProfile'),
  hasLocalSetup: () => ipcRenderer.invoke('pos:hasLocalSetup'),
  logout: () => ipcRenderer.invoke('pos:logout'),
  // Fired whenever the sync engine pulls and applies new data from the
  // cloud (a web sale, a product added elsewhere, etc.) — see sync.js's
  // pullTick and main.js's onDataChanged wiring. Returns an unsubscribe
  // function so callers can clean up in a useEffect the normal way.
  onDataChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('pos:dataChanged', listener);
    return () => ipcRenderer.removeListener('pos:dataChanged', listener);
  },
});
