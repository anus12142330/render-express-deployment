-- 1. Check generated batch numbers (Preview)
SELECT 
    sci.id AS item_id,
    s.ship_uniqid,
    po.po_number,
    sc.container_no,
    sci.product_name,
    CONCAT(
        CASE 
            WHEN po.po_number LIKE '%-%' THEN SUBSTRING(po.po_number, INSTR(po.po_number, '-') + 1)
            ELSE po.po_number 
        END,
        'C',
        DENSE_RANK() OVER (PARTITION BY po.id ORDER BY sc.id), 
        '-',
        ROW_NUMBER() OVER (PARTITION BY sc.id ORDER BY sci.id)
    ) AS calculated_batch_no
FROM shipment_container_item sci
JOIN shipment_container sc ON sc.id = sci.container_id
JOIN shipment s ON s.id = sc.shipment_id
JOIN purchase_orders po ON po.id = s.po_id
WHERE sci.batch_no IS NULL OR sci.batch_no = '';

-- 2. Update the table (Run this to apply changes)
UPDATE shipment_container_item sci
JOIN (
    SELECT 
        sci_inner.id AS item_id,
        CONCAT(
            CASE 
                WHEN po.po_number LIKE '%-%' THEN SUBSTRING(po.po_number, INSTR(po.po_number, '-') + 1)
                ELSE po.po_number 
            END,
            'C',
            DENSE_RANK() OVER (PARTITION BY po.id ORDER BY sc.id), 
            '-',
            ROW_NUMBER() OVER (PARTITION BY sc.id ORDER BY sci_inner.id)
        ) AS new_batch_no
    FROM shipment_container_item sci_inner
    JOIN shipment_container sc ON sc.id = sci_inner.container_id
    JOIN shipment s ON s.id = sc.shipment_id
    JOIN purchase_orders po ON po.id = s.po_id
    WHERE sci_inner.batch_no IS NULL OR sci_inner.batch_no = ''
) AS computed ON sci.id = computed.item_id
SET sci.batch_no = computed.new_batch_no;
