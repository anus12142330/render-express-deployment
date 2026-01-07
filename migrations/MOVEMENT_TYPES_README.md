# Movement Types System

## Overview
The inventory system now uses a comprehensive movement types system to track different types of stock movements and calculate stock on hand accurately.

## Movement Types

| ID | Code | Name | Description | Affects Stock | Direction |
|----|------|------|-------------|---------------|-----------|
| 1 | REGULAR_IN | Regular Stock IN | Regular stock received and available for sale | Yes | IN |
| 2 | REGULAR_OUT | Regular Stock OUT | Regular stock sold or issued | Yes | OUT |
| 3 | IN_TRANSIT | IN TRANSIT | Stock received but in transit (not yet available) | No | NEUTRAL |
| 4 | TRANSIT_OUT | TRANSIT OUT | Stock going out in transit (shipment) | No | NEUTRAL |
| 5 | DISCARD | DISCARD | Stock discarded/rejected (waste) | Yes | OUT |

## Stock on Hand Calculation

**Formula:** `Stock on Hand = Regular Stock + Transit Stock IN - Transit Stock OUT - Regular Stock OUT - Discard`

Or more simply:
- **Stock on Hand = Regular Stock + Net Transit Stock**
- Where **Net Transit Stock = Transit IN - Transit OUT**

## Usage Flow

### Purchase Bill Approval
- When a purchase bill is approved, inventory transactions are created with `movement_type_id = 3` (IN_TRANSIT)
- Stock is NOT added to `inventory_stock_batches` yet
- Stock remains in transit until QC decision

### QC Decisions

#### ACCEPT
- Moves quantity from `movement_type_id = 3` (IN_TRANSIT) to `movement_type_id = 1` (REGULAR_IN)
- Updates `inventory_stock_batches` to add stock
- Stock becomes available for sale

#### REJECT
- Moves quantity from `movement_type_id = 3` (IN_TRANSIT) to `movement_type_id = 5` (DISCARD)
- Updates `inventory_stock_batches` (if discard warehouse is specified)
- Stock is marked as waste

#### REGRADE
- Keeps quantity in `movement_type_id = 3` (IN_TRANSIT)
- Stock remains in transit until regrading job is completed
- When regrading job is posted, quantities are moved based on sellable/discount/waste outputs

#### SELL_RECHECK
- Keeps quantity in `movement_type_id = 3` (IN_TRANSIT)
- When Sell & Recheck entry is marked as completed, moves to `movement_type_id = 1` (REGULAR_IN)
- Stock becomes available for sale

### Sales Invoice
- Uses `movement_type_id = 2` (REGULAR_OUT) for stock sold
- Reduces `inventory_stock_batches` qty_on_hand

### Shipment Out
- Uses `movement_type_id = 4` (TRANSIT_OUT) for stock being shipped
- Does NOT affect `inventory_stock_batches` (stock is in transit, not yet delivered)

## Database Schema

### movement_types Table
```sql
CREATE TABLE movement_types (
  id INT PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  affects_stock_on_hand TINYINT(1) DEFAULT 1,
  stock_direction ENUM('IN', 'OUT', 'NEUTRAL') DEFAULT 'NEUTRAL',
  is_active TINYINT(1) DEFAULT 1,
  sort_order INT DEFAULT 0
);
```

### inventory_transactions Table
- `movement` field: 'IN' or 'OUT' (legacy, kept for compatibility)
- `movement_type_id` field: References `movement_types.id` (new system)

## Migration

Run `add_movement_types_system.sql` to:
1. Create `movement_types` table
2. Insert standard movement types
3. Add `movement_type_id` column to `inventory_transactions`
4. Add foreign key constraint

## API Usage

### Calculate Stock on Hand
```javascript
const movementTypesService = require('./src/modules/inventory/movementTypes.service.cjs');
const stockInfo = await movementTypesService.calculateStockOnHand(conn, productId, warehouseId, batchId);
// Returns: { regular_stock, transit_in, transit_out, net_transit, stock_on_hand }
```

### Get Movement Type
```javascript
const movementType = await movementTypesService.getMovementTypeByCode(conn, 'IN_TRANSIT');
// Returns movement type object with id, code, name, etc.
```

