// middlewares/tenantResolver.js
// IMPORT your database pool here (adjust the path to wherever your pool is exported)
const pool = require('../config/db'); 

const tenantResolver = async (req, res, next) => {
  try {
    const host = req.headers.host || '';
    const subdomain = req.headers['x-tenant'] || host.split('.')[0]; 

    if (!subdomain || subdomain === 'www') {
      return res.status(400).json({ error: 'Tenant subdomain required' });
    }

    const result = await pool.query(
      `SELECT id as account_id, name as account_name 
       FROM accounts 
       WHERE subdomain = $1 LIMIT 1`,
      [subdomain]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant (Account) not found' });
    }

    req.tenant = result.rows[0];
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = tenantResolver;