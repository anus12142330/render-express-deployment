import React, { useState } from 'react';
import {
    Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Typography,
    RadioGroup, FormControlLabel, Radio, TextField, CircularProgress, Grid, FormHelperText
} from '@mui/material';
import axios from 'axios';

export default function PartialShipmentModal({ open, shipment, onClose, onProceedToUnderloading, onSplitSuccess, onError }) {
    const [isPartial, setIsPartial] = useState(null); // 'yes' or 'no'
    const [b2bContainers, setB2bContainers] = useState('');
    const [ssContainers, setSsContainers] = useState('');
    const [errors, setErrors] = useState({});
    const [saving, setSaving] = useState(false);

    const maxB2B = shipment?.containers_back_to_back || 0;
    const maxSS = shipment?.containers_stock_sales || 0;

    const handlePartialChange = (event) => {
        setIsPartial(event.target.value);
        if (event.target.value === 'no') {
            onClose();
            onProceedToUnderloading(shipment);
        }
    };

    const validate = () => {
        const newErrors = {};
        const b2b = Number(b2bContainers) || 0;
        const ss = Number(ssContainers) || 0;

        if (b2b < 0) newErrors.b2b = "Cannot be negative.";
        if (ss < 0) newErrors.ss = "Cannot be negative.";
        if (b2b > maxB2B) newErrors.b2b = `Max available: ${maxB2B}`;
        if (ss > maxSS) newErrors.ss = `Max available: ${maxSS}`;
        if (b2b + ss === 0) newErrors.total = "You must move at least one container.";

        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    };

    const handleSplit = async () => {
        if (!validate()) return;

        const b2bToMove = Number(b2bContainers) || 0;
        const ssToMove = Number(ssContainers) || 0;

        // If user is moving all remaining containers, treat it as a full move, not a split.
        if (b2bToMove === maxB2B && ssToMove === maxSS) {
            onProceedToUnderloading(shipment);
            return;
        }

        setSaving(true);
        try {
            const { data } = await axios.post(`/api/shipment/${shipment.ship_uniqid}/split-shipment`, {
                b2b_containers: Number(b2bContainers) || 0,
                ss_containers: Number(ssContainers) || 0,
            });
            onSplitSuccess(data.newShipUniqid);
        } catch (e) {
            const msg = e.response?.data?.error?.message || "Failed to split shipment.";
            onError(msg);
        } finally {
            setSaving(false);
        }
    };

    const handleClose = () => {
        setIsPartial(null);
        setB2bContainers('');
        setSsContainers('');
        setErrors({});
        onClose();
    };

    return (
        <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
            <DialogTitle>Confirm Shipment Move</DialogTitle>
            <DialogContent dividers>
                <Box sx={{ mb: 2 }}>
                    <Typography>Is this a partial shipment?</Typography>
                    <RadioGroup row value={isPartial} onChange={handlePartialChange}>
                        <FormControlLabel value="yes" control={<Radio />} label="Yes, it's a partial shipment" />
                        <FormControlLabel value="no" control={<Radio />} label="No, move all containers" />
                    </RadioGroup>
                </Box>

                {isPartial === 'yes' && (
                    <Box component={Paper} variant="outlined" sx={{ p: 2, mt: 2, bgcolor: 'grey.50' }}>
                        <Typography variant="h6" gutterBottom>Specify Containers to Move</Typography>
                        <Grid container spacing={2}>
                            <Grid item xs={12} sm={6}>
                                <Typography variant="body2" color="text.secondary">Back to Back Containers</Typography>
                                <TextField
                                    type="number"
                                    size="small"
                                    value={b2bContainers}
                                    onChange={(e) => setB2bContainers(e.target.value)}
                                    error={!!errors.b2b}
                                    helperText={errors.b2b || `Available: ${maxB2B}`}
                                    fullWidth
                                    InputProps={{ inputProps: { min: 0, max: maxB2B } }}
                                />
                            </Grid>
                            <Grid item xs={12} sm={6}>
                                <Typography variant="body2" color="text.secondary">Stock & Sales Containers</Typography>
                                <TextField
                                    type="number"
                                    size="small"
                                    value={ssContainers}
                                    onChange={(e) => setSsContainers(e.target.value)}
                                    error={!!errors.ss}
                                    helperText={errors.ss || `Available: ${maxSS}`}
                                    fullWidth
                                    InputProps={{ inputProps: { min: 0, max: maxSS } }}
                                />
                            </Grid>
                        </Grid>
                        {errors.total && <FormHelperText error sx={{ mt: 1 }}>{errors.total}</FormHelperText>}
                    </Box>
                )}
            </DialogContent>
            <DialogActions>
                <Button onClick={handleClose}>Cancel</Button>
                {isPartial === 'yes' && (
                    <Button
                        variant="contained"
                        onClick={handleSplit}
                        disabled={saving}
                    >
                        {saving ? <CircularProgress size={24} /> : 'Create Partial Shipment'}
                    </Button>
                )}
            </DialogActions>
        </Dialog>
    );
}

// Add Paper to imports if not already there
import { Paper } from '@mui/material';