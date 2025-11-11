import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Box, Typography, CircularProgress, Paper, TextField, Button, Grid, InputAdornment, Tooltip, IconButton } from '@mui/material';
import { DragDropContext, Droppable, Draggable } from 'react-beautiful-dnd';
import axios from 'axios';
import dayjs from 'dayjs';
import ShipmentDetailsModal from './ShipmentDetailsModal';
import { FaShip, FaPlane, FaTruck } from 'react-icons/fa';
import { useAuth } from 'contexts/AuthContext';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import { useNavigate } from 'react-router-dom';
import AsyncSelect from 'react-select/async';

const toUrl = (p) => {
    if (!p) return "";
    const s = String(p);
    if (/^(https?:)?\/\//i.test(s) || s.startsWith("blob:") || s.startsWith("data:")) return s;
    return `${import.meta.env.VITE_APP_BASE_NAME || ""}${s.startsWith("/") ? "" : "/"}${s}`;
};

const ShipmentCard = React.memo(({ shipment, index, onClick }) => {
    const isAir = String(shipment.mode_shipment_id) === '2';
    const isLand = String(shipment.mode_shipment_id) === '3';

    const modeIcon = isAir ? <FaPlane /> : isLand ? <FaTruck /> : <FaShip />;

    return (
        <Draggable draggableId={String(shipment.shipment_id)} index={index}>
            {(provided, snapshot) => (
                <Paper
                    ref={provided.innerRef}
                    {...provided.draggableProps}
                    {...provided.dragHandleProps}
                    onClick={() => onClick(shipment.ship_uniqid)}
                    elevation={snapshot.isDragging ? 4 : 1}
                    sx={{
                        p: 1.5,
                        mb: 1.5,
                        borderRadius: 1.5,
                        cursor: 'pointer',
                        bgcolor: 'background.paper',
                        borderLeft: 5,
                        borderColor: isAir ? 'info.main' : isLand ? 'warning.main' : 'primary.main',
                        '&:hover': { bgcolor: 'action.hover' }
                    }}
                >
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                        <Typography variant="subtitle2" fontWeight={600}>{shipment.po_number}</Typography>
                        <Tooltip title={isAir ? 'Air Freight' : isLand ? 'Land Freight' : 'Sea Freight'}>
                            <Box sx={{ color: 'text.secondary' }}>{modeIcon}</Box>
                        </Tooltip>
                    </Box>
                    <Typography variant="body2" color="text.secondary" noWrap sx={{ mb: 1 }}>
                        {shipment.vendor_name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }} noWrap>
                        {shipment.products}
                    </Typography>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 1 }}>
                        <Typography variant="caption" color="text.secondary">
                            {shipment.etd_date || 'No Date'}
                        </Typography>
                        {shipment.unread_log_count > 0 && (
                            <Box sx={{ bgcolor: 'error.main', color: 'white', borderRadius: '50%', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem' }}>
                                {shipment.unread_log_count}
                            </Box>
                        )}
                    </Box>
                </Paper>
            )}
        </Draggable>
    );
});

const StageColumn = ({ stage, shipments, onCardClick }) => (
    <Paper
        variant="outlined"
        sx={{
            width: 300,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            bgcolor: 'grey.100',
            height: '100%',
            borderRadius: 2,
            overflow: 'hidden'
        }}
    >
        <Box sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
            <Typography variant="h6" sx={{ textTransform: 'uppercase', fontSize: '0.9rem', fontWeight: 600 }}>
                {stage.name} ({shipments.length})
            </Typography>
        </Box>
        <Droppable droppableId={String(stage.id)}>
            {(provided, snapshot) => (
                <Box
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    sx={{
                        flex: 1,
                        overflowY: 'auto',
                        p: 1.5,
                        bgcolor: snapshot.isDraggingOver ? 'primary.light' : 'transparent',
                        transition: 'background-color 0.2s ease'
                    }}
                >
                    {shipments.map((shipment, index) => (
                        <ShipmentCard key={shipment.shipment_id} shipment={shipment} index={index} onClick={onCardClick} />
                    ))}
                    {provided.placeholder}
                </Box>
            )}
        </Droppable>
    </Paper>
);

const reactSelectStyles = {
    control: (base) => ({ ...base, minHeight: 40 }),
    menuPortal: (base) => ({ ...base, zIndex: 9999 })
};

export default function ShipmentBoard() {
    const { user } = useAuth();
    const navigate = useNavigate();
    const [loading, setLoading] = useState(true);
    const [stages, setStages] = useState([]);
    const [shipments, setShipments] = useState([]);
    const [error, setError] = useState('');
    const [selectedShipUniqid, setSelectedShipUniqid] = useState(null);

    // Filter states
    const [filters, setFilters] = useState({ po_number: '', vendor_id: null, product_id: null });
    const [activeFilters, setActiveFilters] = useState({ po_number: '', vendor_id: null, product_id: null });

    const fetchData = useCallback(async (currentFilters) => {
        setLoading(true);
        setError('');
        try {
            const [stagesRes, shipmentsRes] = await Promise.all([
                axios.get('/api/shipment/stages'),
                axios.get('/api/shipment/board', { params: currentFilters })
            ]);
            setStages(stagesRes.data || []);
            setShipments(shipmentsRes.data || []);
        } catch (err) {
            setError(err?.response?.data?.error?.message || 'Failed to load shipment board.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData(activeFilters);
    }, [fetchData, activeFilters]);

    const handleFilterChange = (name, value) => {
        setFilters(prev => ({ ...prev, [name]: value }));
    };

    const applyFilters = () => {
        setActiveFilters(filters);
    };

    const clearFilters = () => {
        const cleared = { po_number: '', vendor_id: null, product_id: null };
        setFilters(cleared);
        setActiveFilters(cleared);
    };

    const onDragEnd = async (result) => {
        const { source, destination, draggableId } = result;
        if (!destination || (source.droppableId === destination.droppableId)) return;

        const shipmentId = draggableId;
        const toStageId = destination.droppableId;
        const shipment = shipments.find(s => String(s.shipment_id) === shipmentId);

        if (!shipment) return;

        // Optimistic UI update
        const newShipments = shipments.map(s =>
            String(s.shipment_id) === shipmentId ? { ...s, stage_id: Number(toStageId) } : s
        );
        setShipments(newShipments);

        try {
            await axios.put(`/api/shipment/${shipment.ship_uniqid}/move`, { to_stage_id: toStageId });
        } catch (err) {
            setError(err?.response?.data?.error?.message || 'Failed to move shipment.');
            // Revert UI on failure
            setShipments(shipments);
        }
    };

    const shipmentsByStage = useMemo(() => {
        return stages.reduce((acc, stage) => {
            acc[stage.id] = shipments.filter(s => s.stage_id === stage.id);
            return acc;
        }, {});
    }, [stages, shipments]);

    const loadVendorOptions = async (inputValue) => {
        try {
            const { data } = await axios.get('/api/vendors/list', { params: { search: inputValue } });
            return data.map(v => ({ value: v.id, label: v.display_name }));
        } catch (error) {
            return [];
        }
    };

    const loadProductOptions = async (inputValue) => {
        try {
            const { data } = await axios.get('/api/products', { params: { search: inputValue, limit: 50 } });
            return (data.data || []).map(p => ({ value: p.id, label: p.name }));
        } catch (error) {
            return [];
        }
    };

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 96px)', p: 2, gap: 2 }}>
            <Paper variant="outlined" sx={{ p: 2, flexShrink: 0, borderRadius: 2 }}>
                <Grid container spacing={2} alignItems="center">
                    <Grid item>
                        <Typography variant="h4" fontWeight={600}>Shipment Board</Typography>
                    </Grid>
                    <Grid item xs>
                        <TextField
                            fullWidth
                            size="small"
                            placeholder="Search by PO Number..."
                            value={filters.po_number}
                            onChange={(e) => handleFilterChange('po_number', e.target.value)}
                            InputProps={{
                                startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment>
                            }}
                        />
                    </Grid>
                    <Grid item xs={12} sm={3}>
                        <AsyncSelect
                            isClearable
                            cacheOptions
                            defaultOptions
                            placeholder="Filter by Vendor..."
                            loadOptions={loadVendorOptions}
                            value={filters.vendor_id}
                            onChange={(option) => handleFilterChange('vendor_id', option)}
                            styles={reactSelectStyles}
                            menuPortalTarget={document.body}
                        />
                    </Grid>
                    <Grid item xs={12} sm={3}>
                        <AsyncSelect
                            isClearable
                            cacheOptions
                            defaultOptions
                            placeholder="Filter by Product..."
                            loadOptions={loadProductOptions}
                            value={filters.product_id}
                            onChange={(option) => handleFilterChange('product_id', option)}
                            styles={reactSelectStyles}
                            menuPortalTarget={document.body}
                        />
                    </Grid>
                    <Grid item>
                        <Button variant="contained" onClick={applyFilters}>Apply</Button>
                    </Grid>
                    <Grid item>
                        <Button variant="text" onClick={clearFilters}>Clear</Button>
                    </Grid>
                    <Grid item>
                        <Tooltip title="Create Shipment from Confirmed PO">
                            <Button variant="contained" color="secondary" startIcon={<AddIcon />} onClick={() => navigate('/purchase/orders')}>
                                Add Shipment
                            </Button>
                        </Tooltip>
                    </Grid>
                </Grid>
            </Paper>

            {loading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
                    <CircularProgress />
                </Box>
            ) : error ? (
                <Typography color="error" sx={{ textAlign: 'center', p: 4 }}>{error}</Typography>
            ) : (
                <DragDropContext onDragEnd={onDragEnd}>
                    <Box sx={{ display: 'flex', gap: 2, overflowX: 'auto', flex: 1, pb: 1 }}>
                        {stages.map(stage => (
                            <StageColumn
                                key={stage.id}
                                stage={stage}
                                shipments={shipmentsByStage[stage.id] || []}
                                onCardClick={(uniqid) => setSelectedShipUniqid(uniqid)}
                            />
                        ))}
                    </Box>
                </DragDropContext>
            )}

            {selectedShipUniqid && (
                <ShipmentDetailsModal
                    open={!!selectedShipUniqid}
                    shipUniqid={selectedShipUniqid}
                    onClose={(update) => {
                        if (update?.shipUniqid) {
                            setShipments(prev => prev.map(s => s.ship_uniqid === update.shipUniqid ? { ...s, unread_log_count: update.unreadCount } : s));
                        }
                        setSelectedShipUniqid(null);
                    }}
                />
            )}
        </Box>
    );
}