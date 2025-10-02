import React, { useState, useEffect } from 'react';
import axios from 'axios';
import {
    Box, Button, Paper, Typography, TextField, Grid,
    Dialog, DialogTitle, DialogContent, DialogActions,
    Select as MuiSelect, MenuItem, FormControl, InputLabel,
    Snackbar, Alert, IconButton
} from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';
import EditIcon from '@mui/icons-material/Edit';
import AddIcon from '@mui/icons-material/Add';

const TemplateModal = ({ open, onClose, onSave, template, companies }) => {
    const [form, setForm] = useState({ title: '', type: '', content: '', company_id: '' });
    const isEditMode = template && template.id;

    useEffect(() => {
        if (template) {
            setForm({
                title: template.title || '',
                type: template.type || '',
                content: template.content || '',
                company_id: template.company_id || (companies.length === 1 ? companies[0].id : ''),
            });
        } else {
            setForm({
                title: '',
                type: '',
                content: '',
                company_id: companies.length === 1 ? companies[0].id : '',
            });
        }
    }, [template, companies]);

    const handleChange = (e) => {
        const { name, value } = e.target;
        setForm(prev => ({ ...prev, [name]: value }));
    };

    const handleSave = () => {
        if (!form.title || !form.type || !form.content) {
            alert('All fields are required.');
            return;
        }
        if (companies.length > 1 && !form.company_id) {
            alert('Please select a company.');
            return;
        }
        onSave({ ...template, ...form });
    };

    return (
        <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
            <DialogTitle>{isEditMode ? 'Edit Template' : 'New Template'}</DialogTitle>
            <DialogContent dividers>
                <Grid container spacing={2} sx={{ mt: 1 }}>
                    {companies.length > 1 && (
                        <Grid item xs={12}>
                            <FormControl fullWidth>
                                <InputLabel id="company-select-label">Company*</InputLabel>
                                <MuiSelect
                                    labelId="company-select-label"
                                    label="Company*"
                                    name="company_id"
                                    value={form.company_id}
                                    onChange={handleChange}
                                >
                                    {companies.map(c => (
                                        <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>
                                    ))}
                                </MuiSelect>
                            </FormControl>
                        </Grid>
                    )}
                    <Grid item xs={12} sm={6}>
                        <TextField
                            label="Title"
                            name="title"
                            value={form.title}
                            onChange={handleChange}
                            fullWidth
                        />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                        <TextField
                            label="Type"
                            name="type"
                            value={form.type}
                            onChange={handleChange}
                            fullWidth
                            placeholder="e.g., Purchase Order, Invoice"
                        />
                    </Grid>
                    <Grid item xs={12}>
                        <TextField
                            label="Content (HTML)"
                            name="content"
                            value={form.content}
                            onChange={handleChange}
                            fullWidth
                            multiline
                            rows={15}
                        />
                    </Grid>
                </Grid>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Cancel</Button>
                <Button onClick={handleSave} variant="contained">
                    {isEditMode ? 'Update' : 'Save'}
                </Button>
            </DialogActions>
        </Dialog>
    );
};

const DocumentTemplatePage = () => {
    const [templates, setTemplates] = useState([]);
    const [companies, setCompanies] = useState([]);
    const [modalOpen, setModalOpen] = useState(false);
    const [editingTemplate, setEditingTemplate] = useState(null);
    const [loading, setLoading] = useState(true);
    const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'success' });

    const fetchTemplates = async () => {
        setLoading(true);
        try {
            const [tplRes, compRes] = await Promise.all([
                axios.get('/api/templatesettings'),
                axios.get('/api/companies')
            ]);
            setTemplates(Array.isArray(tplRes.data) ? tplRes.data : []);
            setCompanies(Array.isArray(compRes.data) ? compRes.data : []);
        } catch (error) {
            setSnackbar({ open: true, message: 'Failed to fetch data.', severity: 'error' });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchTemplates();
    }, []);

    const handleOpenModal = (template = null) => {
        setEditingTemplate(template);
        setModalOpen(true);
    };

    const handleCloseModal = () => {
        setModalOpen(false);
        setEditingTemplate(null);
    };

    const handleSave = async (templateData) => {
        try {
            let response;
            if (templateData.id) { 
                response = await axios.put(`/api/master/document_templates/${templateData.id}`, templateData);
            } else { 
                response = await axios.post('/api/master/document_templates', templateData);
            } 
            setSnackbar({ open: true, message: response.data.message || 'Template saved successfully!', severity: 'success' });
            handleCloseModal();
            fetchTemplates();
        } catch (error) {
            const errorMsg = error.response?.data?.error || 'Failed to save template.';
            setSnackbar({ open: true, message: errorMsg, severity: 'error' });
        }
    };

   

    const columns = [
        { field: 'title', headerName: 'Title', flex: 1 },
        { field: 'type', headerName: 'Type', flex: 1 },
        {
            field: 'company_name',
            headerName: 'Company',
            flex: 1,
            renderCell: (params) => params.value || 'Global'
        },
        {
            field: 'actions',
            headerName: 'Actions',
            sortable: false,
            width: 100,
            renderCell: (params) => (
                <IconButton onClick={() => handleOpenModal(params.row)}>
                    <EditIcon />
                </IconButton>
            ),
        },
    ];

    return (
        <Paper sx={{ p: 3, m: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
                <Typography variant="h4">Document Templates</Typography>
                <Button
                    variant="contained"
                    startIcon={<AddIcon />}
                    onClick={() => handleOpenModal()}
                >
                    New Template
                </Button>
            </Box>
            <Box sx={{ height: 600, width: '100%' }}>
                <DataGrid
                    rows={templates}
                    columns={columns}
                    loading={loading}
                    pageSizeOptions={[10, 25, 50]}
                    initialState={{
                        pagination: {
                            paginationModel: { pageSize: 10 },
                        },
                    }}
                />
            </Box>
            {modalOpen && (
                <TemplateModal
                    open={modalOpen}
                    onClose={handleCloseModal}
                    onSave={handleSave}
                    template={editingTemplate}
                    companies={companies}
                />
            )}
            <Snackbar
                open={snackbar.open}
                autoHideDuration={4000}
                onClose={() => setSnackbar({ ...snackbar, open: false })}
                anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
            >
                <Alert onClose={() => setSnackbar({ ...snackbar, open: false })} severity={snackbar.severity} sx={{ width: '100%' }}>
                    {snackbar.message}
                </Alert>
            </Snackbar>
        </Paper>
    );
};

export default DocumentTemplatePage;
